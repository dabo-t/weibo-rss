/**
 * Created by qing on 17-10-1.
 */
const axios = require('axios');
const RSS = require('rss');
const Queue = require('np-queue');
const logger = require('./logger');
const cache = require('./cache');
const utils = require('./utils');

// reuse SSL connection
const https = require('https');
const httpsAgent = new https.Agent({ keepAlive: true });

const axiosInstance = axios.create({
  timeout:8000,
  httpsAgent
});

axiosInstance.interceptors.request.use(config => {
  logger.debug(`axios ${config.method} ${config.url}`);
  return config;
});

exports.fetchRSS = async function (uid, options) {
  if (!options) options = {};
  // 大图显示
  if (options.largePic === undefined) {
    options.largePic = true;
  }
  // TTL
  if (options.ttl === undefined) {
    options.ttl = 10;
  }
  // 表情图标
  if (options.emoji === undefined) {
    options.emoji = false;
  }

  // start
  const {
    userNotExist,
    requestSuccess,
    weiboData } = await getWeiboData(uid);

  let resultXML;
  if (weiboData) {
    // metadata
    var feed = new RSS({
      site_url: "https://weibo.com/" + uid,
      title: weiboData.user ? weiboData.user.screen_name + '的微博' : '',
      description: weiboData.user ? weiboData.user.description : '',
      generator: 'https://github.com/zgq354/weibo-rss',
      ttl: options.ttl
    });
    // content
    weiboData.statuses.forEach(function (detail) {
      if (!detail) return;
      feed.item({
        title: detail.status_title || (detail.text ? detail.text.replace(/<[^>]+>/g, '').replace(/[\n]/g, '').substr(0, 25) : null),
        description: utils.formatStatus(detail, options.largePic, options.emoji),
        url: 'https://weibo.com/' + uid + '/' + detail.bid,
        guid: 'https://weibo.com/' + uid + '/' + detail.bid,
        date: new Date(detail.created_at)
      });
    });
    resultXML = feed.xml();
  }

  return {
    userNotExist,
    requestSuccess,
    resultXML
  };
};

// 通过用户的个性域名获取UID
exports.getUIDByDomain = function (domain) {
  // 利用手机版的跳转获取
  return axios.get(`https://m.weibo.cn/${domain}?&jumpfrom=weibocom`, {
    timeout: 3000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.3 Mobile/15E148 Safari/604.1'
    },
  }).then(res => {
    const uid = res.request.path.split("/u/")[1];
    return {
      uid,
      notFound: !uid,
    };
  });
};

/**
 * 获取最近发的微博
 */
async function getWeiboData(uid) {
  let resultList = [];
  let tempResultObject = await getByIndexAPI(uid);
  resultList.push(tempResultObject);

  // result
  let weiboData;
  let userNotExist = resultList.every(item => item && item.userNotExist);
  let requestSuccess = resultList.some(item => item && item.requestSuccess);

  // backup cache
  let cacheWeiboData = await cache.get(`wbdata-${uid}`);
  if (!requestSuccess && !tempResultObject.weiboData && cacheWeiboData) {
    logger.info(`bkcache-${uid}`);
    tempResultObject.weiboData = cacheWeiboData;
    requestSuccess = true;
  } else if (requestSuccess && !tempResultObject.userNotExist) {
    cache.set(`wbdata-${uid}`, tempResultObject.weiboData, 86400000);
  }

  if (!tempResultObject.userNotExist && requestSuccess) {
    weiboData = await handleLongText(tempResultObject.weiboData);
  }

  return {
    userNotExist,
    requestSuccess,
    weiboData
  };
};

/**
 * 出错时自动暂停
 */
const avaliableMethod = {
  methods: {
    indexAPI: {
      enable: true,
      lastUpdatedTime: Date.now(),
      retryDelay: 600000,
    },
    weiboDetail: {
      enable: true,
      lastUpdatedTime: Date.now(),
      retryDelay: 600000,
    }
  },
  check: function (name) {
    let methodObj = this.methods[name];
    if (!methodObj.enable && Date.now() - methodObj.lastUpdatedTime > methodObj.retryDelay) {
      methodObj.enable = true;
    }
    return methodObj.enable;
  },
  disable: function (name) {
    this.methods[name].enable = false;
    this.methods[name].lastUpdatedTime = Date.now();
    logger.info(`Disable function ${name}`);
  }
};

// 缓存过期时间
const userinfoExpire = 3 * 24 * 3600;
const detailExpire = 7 * 24 * 3600;

// 并发任务队列
const indexAPIQueue = new Queue({
  concurrency: 1
});

const detailQueue = new Queue({
  concurrency: 1
});

/**
 * container/getIndex
 */
async function getByIndexAPI(uid) {
  logger.debug(`getByIndex: ${uid}`);
  if (!avaliableMethod.check('indexAPI')) {
    return {
      requestSuccess: false,
    };
  }
  try {
    const { userInfo, userNotExist } = await getIndexUserInfo(uid);
    let requestSuccess = true;
    if (userNotExist) {
      return {
        requestSuccess,
        userNotExist
      };
    }
    // status
    const { containerid } = userInfo;
    // wait queue
    await indexAPIQueue.add(utils.delayFunc(Math.floor(Math.random() * 100)));
    const weiboStatuses = await axiosInstance({
      method: 'get',
      url: `https://m.weibo.cn/api/container/getIndex?type=uid&value=${uid}&containerid=${containerid}`,
      headers: {
        'MWeibo-Pwa': 1,
        'Referer': `https://m.weibo.cn/u/${uid}`,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.3 Mobile/15E148 Safari/604.1',
        'X-Requested-With': 'XMLHttpRequest'
      }
    }).then(({ data }) => {
      const statuses = data.data.cards
        .filter(item => item.mblog)
        .map(item => {
          item.mblog.created_at = utils.revertRelativeDate(item.mblog.created_at);
          return item.mblog;
        });
      return statuses;
    });

    return {
      requestSuccess,
      userNotExist,
      weiboData: {
        user: userInfo,
        statuses: weiboStatuses,
      },
    };
  } catch (err) {
    if (err.response && [418, 403].includes(err.response.status)) {
      avaliableMethod.disable('indexAPI');
      requestSuccess = false;
      return;
    } else {
      return Promise.reject(err);
    }
  }
}

/**
 * get container id
 */
async function getIndexUserInfo(uid) {
  logger.debug(`getUserInfo: ${uid}`);
  let userNotExist = false;
  const cacheKey = `info-${uid}`;
  let cacheResult = await cache.get(cacheKey);
  if (cacheResult) {
    logger.debug(`getUserInfo: ${uid} hit cache`);
    return {
      userNotExist,
      userInfo: cacheResult,
    }
  }
  // wait queue
  await indexAPIQueue.add(utils.delayFunc(Math.floor(Math.random() * 100)));
  const userInfo = await axiosInstance({
    method: 'get',
    url: `https://m.weibo.cn/api/container/getIndex?type=uid&value=${uid}`,
    headers: {
      'MWeibo-Pwa': 1,
      'Referer': `https://m.weibo.cn/u/${uid}`,
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.3 Mobile/15E148 Safari/604.1',
      'X-Requested-With': 'XMLHttpRequest'
    }
  }).then(({ data }) => {
    if (data.ok !== 1) {
      userNotExist = true;
      return;
    }
    const result = {
      screen_name: data.data.userInfo.screen_name,
      description: data.data.userInfo.description,
      containerid: data.data.tabsInfo.tabs[1].containerid,
    };
    cache.set(cacheKey, result, userinfoExpire);
    return result;
  });
  return {
    userNotExist,
    userInfo
  };
}

/**
 * 尝试获取微博列表全文
 */
function handleLongText(weiboData) {
  const listPromises = [];
  weiboData.statuses.forEach(status => {
    if (!status.isLongText && (!status.retweeted_status || !status.retweeted_status.isLongText)) {
      listPromises.push(status);
    } else {
      listPromises.push(getWeiboDetail(status.id)
        .then(function (detail) {
          // 全文获取失败，恢复原状
          if (!detail) {
            return status;
          }
          return detail;
        }));
    }
  });
  return Promise.all(listPromises)
    .then(function (listArr) {
      weiboData.statuses = listArr;
      return weiboData;
    });
}

/**
 * 获取全文
 */
async function getWeiboDetail(id) {
  logger.debug(`getWeiboDetail: ${id}`);
  const key = `detail-${id}`;
  let cacheResult = await cache.get(key);
  if (cacheResult) {
    return cacheResult;
  }
  if (!avaliableMethod.check('weiboDetail')) {
    return;
  }
  // wait queue
  await detailQueue.add(utils.delayFunc(Math.floor(Math.random() * 100)));
  const result = await axiosInstance({
    method: 'get',
    url: `https://m.weibo.cn/statuses/show?id=${id}`,
    headers: {
      'MWeibo-Pwa': 1,
      'Referer': `https://m.weibo.cn/detail/${id}`,
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.3 Mobile/15E148 Safari/604.1',
      'X-Requested-With': 'XMLHttpRequest'
    }
  }).then(res => {
    data = res.data.data;
    return data;
  }).catch(err => {
    if (err.response && [418, 403].includes(err.response.status)) {
      avaliableMethod.disable('weiboDetail');
      return;
    } else {
      return Promise.reject(err);
    }
  });
  cache.set(key, result, detailExpire);
  return result;
}

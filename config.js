/**
 * config.js
 */

const config = {
  debug: !!process.env.DEBUG,
  TTL: 15, // 微博缓存时间（分钟）
};

module.exports = config;

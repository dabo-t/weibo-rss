/**
 * config.js
 */

const config = {
  debug: !!process.env.DEBUG,
  TTL: 10, // 微博缓存时间（分钟）
};

module.exports = config;

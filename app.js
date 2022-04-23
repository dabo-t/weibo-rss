
const Koa = require('koa');
const serve = require('koa-static');
const router = require('./core/router');
const logger = require('./core/logger');

const app = new Koa();

// enable X-Forwarded-For
app.proxy = true;

// logger
app.use(async (ctx, next) => {
  const startTime = Date.now();
  logger.debug(`${ctx.req.method} ${ctx.originalUrl} ${ctx.ip}`);
  await next();
  const hitLog = ctx.state.hitCache !== undefined ? ' hit: ' + ctx.state.hitCache : '';
  logger.info(`[${ctx.status}] ${ctx.req.method} ${ctx.originalUrl} ${ctx.ip}${hitLog} ${Date.now() - startTime}ms`);
});

app.use(serve(__dirname + '/public'));
app.use(router.routes());

app.start = function (port) {
  app.listen(port, function () {
    logger.info(`weibo-rss start`);
    logger.info(`Listening Port ${port}`);
  });
};

module.exports = app;

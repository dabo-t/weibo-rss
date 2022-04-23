/**
 * Created by qing on 17-10-2.
 */
const config = require('../config');

const logger = require('tracer').colorConsole({
  format : "[{{timestamp}}] [{{title}}] {{message}}",
  level: config.debug ? 'debug' : 'info',
});

module.exports = logger;

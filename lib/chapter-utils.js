const classification = require('./chapters/classification');
const textSanitization = require('./chapters/text-sanitization');
const partitioning = require('./chapters/partitioning');
const validation = require('./chapters/validation');

module.exports = {
  ...classification,
  ...textSanitization,
  ...partitioning,
  ...validation
};

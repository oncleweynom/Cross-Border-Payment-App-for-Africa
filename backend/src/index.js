require('dotenv').config();

const logger = require('./utils/logger');
const validateEnv = require('./utils/validateEnv');
const app = require('./app');
const { startScheduler } = require('./scheduler');

validateEnv();

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`, { port: PORT });
  startScheduler();
});

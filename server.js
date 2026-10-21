'use strict';

const { MongoClient } = require('mongodb');
const { createApp } = require('./src/app');
const { closeExpiredSurveys } = require('./src/survey-status');

async function main() {
  const client = new MongoClient(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/survey_system');
  await client.connect();
  const db = client.db();
  const surveys = db.collection('surveys');
  await closeExpiredSurveys(surveys);
  const sweep = setInterval(() => {
    closeExpiredSurveys(surveys).catch((error) => console.error('Failed to close expired surveys:', error));
  }, 30000);
  sweep.unref();
  const app = createApp(db);
  const server = app.listen(Number(process.env.PORT || 3000), () => {
    console.log(`Survey API listening on http://localhost:${server.address().port}`);
  });
  const close = async () => {
    clearInterval(sweep);
    server.close();
    await client.close();
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

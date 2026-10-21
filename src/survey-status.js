'use strict';

async function closeExpiredSurveys(surveys, filter = {}) {
  const now = new Date();
  return surveys.updateMany(
    { ...filter, status: 'published', deadline: { $type: 'date', $lte: now } },
    { $set: { status: 'closed', draftBaseVersionId: null, updatedAt: now } }
  );
}

module.exports = { closeExpiredSurveys };

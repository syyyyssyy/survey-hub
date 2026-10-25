// Run with: mongosh "mongodb://localhost:27017/survey_system" --file init-mongodb.js
// The selected database is supplied by the connection string.

const integerType = { bsonType: ["int", "long"] };
const numberType = { bsonType: ["int", "long", "double", "decimal"] };

const questionSchema = {
  bsonType: "object",
  required: ["qid", "type", "title", "required"],
  oneOf: [
    {
      properties: {
        type: { enum: ["rating"] },
        validation: {
          bsonType: "object",
          required: ["min", "max", "integer"],
          properties: {
            min: { bsonType: ["int", "long"], minimum: 1, maximum: 9 },
            max: { bsonType: ["int", "long"], minimum: 2, maximum: 10 },
            integer: { enum: [true] }
          }
        }
      },
      required: ["validation"]
    },
    { properties: { type: { enum: ["single", "multi", "text", "number"] } } }
  ],
  properties: {
    qid: { bsonType: "string" },
    libraryQuestionId: { bsonType: "string", pattern: "^[0-9a-f]{24}$" },
    questionVersionId: { bsonType: "string", pattern: "^[0-9a-f]{24}$" },
    contentRevision: { bsonType: ["int", "long"], minimum: 1 },
    type: { enum: ["single", "multi", "text", "number", "rating"] },
    title: { bsonType: "string" },
    required: { bsonType: "bool" },
    options: {
      bsonType: "array",
      items: {
        bsonType: "object",
        required: ["id", "text"],
        properties: {
          id: { bsonType: "string" },
          text: { bsonType: "string" }
        }
      }
    },
    validation: {
      bsonType: "object",
      properties: {
        minSelect: integerType,
        maxSelect: integerType,
        exactSelect: { bsonType: ["int", "long", "null"] },
        minLength: integerType,
        maxLength: integerType,
        min: numberType,
        max: numberType,
        integer: { bsonType: "bool" }
      }
    },
    jumpRules: {
      bsonType: "array",
      items: {
        bsonType: "object",
        required: ["id", "when", "targetQid"],
        properties: {
          id: { bsonType: "string" },
          when: {
            bsonType: "object",
            oneOf: [
              { required: ["optionId"] },
              { required: ["containsOptionId"] },
              { required: ["containsAnyOptionIds"] },
              { required: ["containsAllOptionIds"] },
              { required: ["exactOptionIds"] },
              { required: ["excludesOptionIds"] },
              { required: ["op", "value"] },
              { required: ["op", "min", "max"] }
            ],
            properties: {
              optionId: { bsonType: "string" },
              containsOptionId: { bsonType: "string" },
              containsAnyOptionIds: { bsonType: "array", minItems: 1, items: { bsonType: "string" } },
              containsAllOptionIds: { bsonType: "array", minItems: 1, items: { bsonType: "string" } },
              exactOptionIds: { bsonType: "array", minItems: 1, items: { bsonType: "string" } },
              excludesOptionIds: { bsonType: "array", minItems: 1, items: { bsonType: "string" } },
              op: { enum: ["gte", "gt", "lte", "lt", "eq", "between"] },
              value: numberType,
              min: numberType,
              max: numberType
            }
          },
          targetQid: { bsonType: "string" }
        }
      }
    }
  }
};

const collections = {
  users: {
    bsonType: "object",
    required: ["_id", "username", "passwordHash", "createdAt", "updatedAt"],
    properties: {
      _id: { bsonType: "objectId" },
      username: { bsonType: "string" },
      passwordHash: { bsonType: "string" },
      createdAt: { bsonType: "date" },
      updatedAt: { bsonType: "date" }
    }
  },
  surveys: {
    bsonType: "object",
    required: ["_id", "ownerId", "publicId", "title", "description", "allowAnonymous", "allowMultiple", "status", "deadline", "draftQuestions", "publishedVersionId", "createdAt", "updatedAt"],
    properties: {
      _id: { bsonType: "objectId" },
      ownerId: { bsonType: "objectId" },
      publicId: { bsonType: "string" },
      title: { bsonType: "string" },
      description: { bsonType: "string" },
      allowAnonymous: { bsonType: "bool" },
      allowMultiple: { bsonType: "bool" },
      status: { enum: ["draft", "published", "closed"] },
      deadline: { bsonType: ["date", "null"] },
      draftQuestions: { bsonType: "array", items: questionSchema },
      draftBaseVersionId: { bsonType: ["objectId", "null"] },
      publishedVersionId: { bsonType: ["objectId", "null"] },
      createdAt: { bsonType: "date" },
      updatedAt: { bsonType: "date" }
    }
  },
  survey_versions: {
    bsonType: "object",
    required: ["_id", "surveyId", "version", "questions", "publishedAt", "publishedBy"],
    properties: {
      _id: { bsonType: "objectId" },
      surveyId: { bsonType: "objectId" },
      version: integerType,
      questions: { bsonType: "array", items: questionSchema },
      publishedAt: { bsonType: "date" },
      publishedBy: { bsonType: "objectId" }
    }
  },
  question_banks: {
    bsonType: "object", required: ["_id", "ownerId", "name", "createdAt", "updatedAt"],
    properties: { _id: { bsonType: "objectId" }, ownerId: { bsonType: "objectId" },
      name: { bsonType: "string" }, createdAt: { bsonType: "date" }, updatedAt: { bsonType: "date" } }
  },
  library_questions: {
    bsonType: "object", required: ["_id", "bankId", "ownerId", "sharedWith", "currentVersionId", "createdAt", "updatedAt"],
    properties: { _id: { bsonType: "objectId" }, bankId: { bsonType: ["objectId", "null"] },
      ownerId: { bsonType: "objectId" }, sharedWith: { bsonType: "array", items: { bsonType: "objectId" } },
      currentVersionId: { bsonType: "objectId" }, createdAt: { bsonType: "date" }, updatedAt: { bsonType: "date" },
      archivedAt: { bsonType: "date" }, shareTokenHash: { bsonType: "string" },
      originRefs: { bsonType: "array", items: { bsonType: "object", required: ["surveyVersionId", "qid", "questionVersionId"],
        properties: { surveyVersionId: { bsonType: "objectId" }, qid: { bsonType: "string" },
          questionVersionId: { bsonType: "objectId" } } } } }
  },
  question_versions: {
    bsonType: "object", required: ["_id", "questionId", "version", "content", "sourceVersionId", "createdAt", "createdBy"],
    properties: { _id: { bsonType: "objectId" }, questionId: { bsonType: "objectId" },
      version: integerType, sourceVersionId: { bsonType: ["objectId", "null"] },
      contentRevision: integerType,
      contentHistory: { bsonType: "array", items: { bsonType: "object", required: ["revision", "content"],
        properties: { revision: integerType, content: { bsonType: "object" } } } },
      content: { bsonType: "object", required: ["type", "title", "required"],
        properties: { type: { enum: ["single", "multi", "text", "number", "rating"] },
          title: { bsonType: "string" }, required: { bsonType: "bool" },
          options: questionSchema.properties.options, validation: questionSchema.properties.validation } },
      createdAt: { bsonType: "date" }, createdBy: { bsonType: "objectId" } }
  },
  responses: {
    bsonType: "object",
    required: ["_id", "surveyId", "versionId", "respondentId", "respondentKey", "anonymous", "clientSubmissionId", "answers", "path", "submittedAt"],
    properties: {
      _id: { bsonType: "objectId" },
      surveyId: { bsonType: "objectId" },
      versionId: { bsonType: "objectId" },
      respondentId: { bsonType: ["objectId", "null"] },
      respondentKey: { bsonType: "string" },
      dedupeKey: { bsonType: ["string", "null"] },
      anonymous: { bsonType: "bool" },
      clientSubmissionId: { bsonType: "string" },
      answers: {
        bsonType: "array",
        items: {
          bsonType: "object",
          required: ["qid", "type", "value"],
          properties: {
            qid: { bsonType: "string" },
            type: { enum: ["single", "multi", "text", "number", "rating"] },
            value: {
              bsonType: ["string", "array", "int", "long", "double", "decimal"],
              items: { bsonType: "string" }
            }
          }
        }
      },
      path: { bsonType: "array", items: { bsonType: "string" } },
      submittedAt: { bsonType: "date" }
    }
  }
};

for (const [name, schema] of Object.entries(collections)) {
  const validator = { $jsonSchema: schema };
  let result;
  if (db.getCollectionInfos({ name }).length === 0) {
    result = db.createCollection(name, { validator, validationLevel: "strict", validationAction: "error" });
  } else {
    result = db.runCommand({ collMod: name, validator, validationLevel: "strict", validationAction: "error" });
  }
  if (result.ok !== 1) {
    throw new Error(`Failed to initialize ${name}: ${result.errmsg || JSON.stringify(result)}`);
  }
}

db.users.createIndex({ username: 1 }, { name: "username_unique", unique: true });
db.surveys.createIndex({ publicId: 1 }, { name: "publicId_unique", unique: true });
db.surveys.createIndex({ ownerId: 1, createdAt: -1 }, { name: "owner_createdAt" });
db.survey_versions.createIndex({ surveyId: 1, version: 1 }, { name: "survey_version_unique", unique: true });
db.responses.createIndex(
  { surveyId: 1, respondentKey: 1, clientSubmissionId: 1 },
  { name: "submission_unique", unique: true }
);
db.responses.createIndex(
  { surveyId: 1, versionId: 1, submittedAt: -1, _id: -1 },
  { name: "survey_version_submittedAt_id" }
);
db.responses.createIndex(
  { dedupeKey: 1 },
  { name: "dedupeKey_unique", unique: true, partialFilterExpression: { dedupeKey: { $type: "string" } } }
);
db.question_banks.createIndex({ ownerId: 1, name: 1 }, { name: "owner_name", unique: true });
for (const oldName of ["bank_createdAt", "sharedWith"]) {
  if (db.library_questions.getIndexes().some((index) => index.name === oldName)) {
    db.library_questions.dropIndex(oldName);
  }
}
db.library_questions.createIndex({ ownerId: 1, bankId: 1, createdAt: -1 },
  { name: "owner_bank_createdAt" });
db.library_questions.createIndex({ shareTokenHash: 1 }, { name: "shareTokenHash", unique: true,
  partialFilterExpression: { shareTokenHash: { $type: "string" } } });
db.question_versions.createIndex({ questionId: 1, version: 1 }, { name: "question_version_unique", unique: true });
db.surveys.createIndex({ "draftQuestions.libraryQuestionId": 1 }, { name: "draft_library_question" });
db.survey_versions.createIndex({ "questions.libraryQuestionId": 1 }, { name: "published_library_question" });

print(`Initialized ${db.getName()}: ${Object.keys(collections).join(", ")}`);

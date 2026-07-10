const { schedule } = require('@netlify/functions');
const { __internal } = require('./submit-contact.js');

const QUEUE_BATCH_SIZE = Number.parseInt(process.env.KIT_QUEUE_BATCH_SIZE || '10', 10);
// Items that keep failing must eventually leave the pending/ prefix: the
// queue is processed oldest-first, so without a cap a handful of permanently
// failing items would monopolize every run and starve newer opt-ins forever.
const QUEUE_MAX_ATTEMPTS = Number.parseInt(process.env.KIT_QUEUE_MAX_ATTEMPTS || '12', 10);

async function moveToFailed(store, key, item, error) {
  const failedKey = key.replace(/^pending\//, 'failed/');
  await store.setJSON(failedKey, {
    ...item,
    failedAt: new Date().toISOString(),
    lastError: __internal.kitErrorSummary(error),
  });
  await store.delete(key);
}

async function processQueuedOptins() {
  const store = __internal.getOptinQueueStore();
  const batchSize = Number.isSafeInteger(QUEUE_BATCH_SIZE) && QUEUE_BATCH_SIZE > 0
    ? QUEUE_BATCH_SIZE
    : 10;
  let processed = 0;
  let succeeded = 0;
  let retained = 0;
  let failed = 0;

  for await (const page of store.list({ paginate: true, prefix: 'pending/' })) {
    for (const blob of page.blobs || []) {
      if (processed >= batchSize) {
        return { processed, succeeded, retained, failed };
      }

      const key = blob.key;
      let item;
      try {
        item = await store.get(key, { type: 'json' });
      } catch (error) {
        // A corrupt blob would otherwise abort this and every future run at
        // the same key (oldest-first ordering). Park it and move on.
        await moveToFailed(store, key, { corrupt: true }, error);
        processed += 1;
        failed += 1;
        continue;
      }
      if (!item?.submission) {
        await store.delete(key);
        processed += 1;
        failed += 1;
        continue;
      }

      try {
        await __internal.syncContactToKit(item.submission);
        await store.delete(key);
        succeeded += 1;
      } catch (error) {
        const updated = {
          ...item,
          submission: {
            ...item.submission,
            ...(error?.submissionPatch || {}),
          },
          attempts: (item.attempts || 0) + 1,
          lastAttemptAt: new Date().toISOString(),
          lastError: __internal.kitErrorSummary(error),
        };

        if (__internal.isQueueableKitError(error) && updated.attempts < QUEUE_MAX_ATTEMPTS) {
          await store.setJSON(key, updated);
          retained += 1;
        } else {
          await moveToFailed(store, key, updated, error);
          failed += 1;
        }
      }

      processed += 1;
    }
  }

  return { processed, succeeded, retained, failed };
}

exports.handler = schedule('* * * * *', async () => {
  const result = await processQueuedOptins();
  console.log('Processed Kit opt-in queue', result);
  return {
    statusCode: 200,
    body: JSON.stringify(result),
  };
});

module.exports.__test = { processQueuedOptins };

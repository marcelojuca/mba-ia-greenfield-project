// Loaded by Jest after `dotenv/config` (see package.json and test/jest-e2e.json).
// Test queues live under their own Redis prefix so the always-running
// `video-worker` container never consumes jobs created by tests
// (phase-03-videos validation AMB-4).
process.env.QUEUE_PREFIX = 'streamtube-test';

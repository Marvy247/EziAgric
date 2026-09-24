import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL } from './options.js';

// Strict rolling-deploy verification scenario (issue #265): read traffic
// runs for the whole rollout and the ONLY acceptable outcome is zero failed
// requests (rate==0), stricter than the 1% budget in load-test.js.
export const options = {
  stages: [
    { duration: '30s', target: 10 },
    { duration: '2m', target: 20 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate==0'],
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
  },
};

export default function () {
  const live = http.get(`${BASE_URL}/health/live`);
  check(live, { 'live is 200': (r) => r.status === 200 });

  // /health exercises the full dependency matrix; during a correct rolling
  // deploy the surviving replicas keep it 200 while old pods drain.
  const health = http.get(`${BASE_URL}/health`);
  check(health, { 'health is 200': (r) => r.status === 200 });

  sleep(0.3);
}

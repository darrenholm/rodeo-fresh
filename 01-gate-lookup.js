import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "https://rodeo-fresh-staging.up.railway.app";
const DURATION = __ENV.DURATION || "5m";
const PEAK_VUS = parseInt(__ENV.PEAK_VUS || "50");

const errorRate = new Rate("errors");
const lookupTime = new Trend("wristband_lookup_ms", true);

// Generate the same UIDs the seed script generated
function generateUids(count, byteCount) {
  const seq = new Array(byteCount).fill(0);
  const out = [];
  while (out.length < count) {
    out.push(seq.map(b => b.toString(16).padStart(2, "0").toUpperCase()).join(""));
    let i = byteCount - 1;
    while (i >= 0 && seq[i] === 255) i--;
    if (i < 0) break;
    seq[i]++;
    for (let j = i + 1; j < byteCount; j++) seq[j] = seq[i];
  }
  return out;
}
const UIDS = generateUids(3500, 4);

export const options = {
  scenarios: {
    gate_lookup: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "30s", target: PEAK_VUS },
        { duration: DURATION, target: PEAK_VUS },
        { duration: "15s", target: 0 },
      ],
      gracefulRampDown: "10s",
    },
  },
  thresholds: {
    "http_req_duration{name:wristband_lookup}": ["p(95)<500", "p(99)<1500"],
    "http_req_failed": ["rate<0.01"],
    "errors": ["rate<0.05"],
  },
};

export function setup() {
  const res = http.post(`${BASE_URL}/api/auth/login`, JSON.stringify({
    email: "gate@staging.test",
    password: "staging-test-pass",
  }), { headers: { "Content-Type": "application/json" } });
  if (res.status !== 200) throw new Error(`Setup login failed: ${res.status} ${res.body}`);
  return { token: res.json("token") };
}

export default function (data) {
  const headers = { "Authorization": `Bearer ${data.token}`, "Content-Type": "application/json" };
  const uid = UIDS[Math.floor(Math.random() * UIDS.length)];
  const res = http.get(`${BASE_URL}/api/wristbands/rfid/${uid}`, { headers, tags: { name: "wristband_lookup" } });
  const ok = check(res, {
    "status 200": (r) => r.status === 200,
    "has rfid_uid": (r) => r.json("rfid_uid") !== undefined,
  });
  if (!ok) {
    errorRate.add(1);
    if (Math.random() < 0.01) console.log(`Failed: ${res.status} for ${uid} body=${res.body.substring(0, 100)}`);
  } else {
    errorRate.add(0);
  }
  lookupTime.add(res.timings.duration);
  sleep(1 + Math.random() * 3);
}

import { execSync } from "node:child_process";

const port = Number(process.argv[2] || process.env.PORT || 3001);

function parseWindowsPids(raw) {
  const pids = new Set();
  const lines = String(raw || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    // Example:
    // TCP    0.0.0.0:3001   0.0.0.0:0   LISTENING   16660
    const parts = line.split(/\s+/);
    const state = parts[3] || "";
    const pid = Number(parts[4]);
    if (state.toUpperCase() === "LISTENING" && Number.isFinite(pid) && pid > 0) {
      pids.add(pid);
    }
  }

  return [...pids];
}

function killPidWindows(pid) {
  try {
    execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function freePortWindows(targetPort) {
  let output = "";
  try {
    output = execSync(`netstat -ano | findstr :${targetPort}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // No listeners found.
    return;
  }

  const pids = parseWindowsPids(output);
  if (pids.length === 0) return;

  for (const pid of pids) {
    const killed = killPidWindows(pid);
    if (killed) {
      // Keep this concise because script runs on every dev start.
      console.log(`[dev] Freed port ${targetPort} by stopping PID ${pid}`);
    }
  }
}

if (process.platform === "win32") {
  freePortWindows(port);
}

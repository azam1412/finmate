// Pembantu pengujian HTTP (Stage 2.3a): menjalankan src/app.js sebagai proses anak
// pada port tertentu, lalu mengirim request ke sana.
// Setiap file tes memakai rentang port sendiri karena Node menjalankan file tes secara paralel:
//   foundation.test.js 3101-3104 | httpTransactionCreate 3201-3209 | httpSecurity 3211-3229

import "dotenv/config";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const APP_PATH = fileURLToPath(new URL("../../src/app.js", import.meta.url));

export function startServer(port, env = {}) {
    return new Promise((resolve, reject) => {
        const childEnv = { ...process.env, CORS_ORIGINS: "", PORT: String(port), ...env };

        // env: { X: undefined } berarti "hapus variabel ini"
        for (const [key, value] of Object.entries(childEnv)) {
            if (value === undefined) {
                delete childEnv[key];
            }
        }

        const child = spawn(process.execPath, [APP_PATH], {
            env: childEnv,
            stdio: ["ignore", "pipe", "pipe"],
        });

        let output = "";
        let settled = false;

        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`Server on port ${port} did not start in time`));
        }, 20000);

        child.stdout.on("data", (chunk) => {
            output += String(chunk);

            if (!settled && output.includes("Server is running")) {
                settled = true;
                clearTimeout(timer);
                resolve({
                    port,
                    child,
                    get output() {
                        return output;
                    },
                    base: `http://127.0.0.1:${port}`,
                    stop() {
                        child.removeAllListeners("exit");
                        child.kill();
                    },
                });
            }
        });

        child.stderr.on("data", (chunk) => {
            output += String(chunk);
        });

        child.on("exit", (code) => {
            if (!settled) {
                clearTimeout(timer);
                reject(new Error(`Server on port ${port} exited early with code ${code}: ${output}`));
            }
        });
    });
}

// Mengirim request dan mengembalikan { status, headers, text, json }.
// body: objek -> dikirim sebagai JSON; string -> dikirim apa adanya (untuk tes JSON rusak, dll).
export async function call(base, method, path, { body, headers = {}, json = true } = {}) {
    const finalHeaders = { ...headers };
    let payload;

    if (body !== undefined) {
        payload = typeof body === "string" ? body : JSON.stringify(body);

        if (json && !Object.keys(finalHeaders).some((k) => k.toLowerCase() === "content-type")) {
            finalHeaders["Content-Type"] = "application/json";
        }
    }

    const response = await fetch(`${base}${path}`, { method, headers: finalHeaders, body: payload });
    const text = await response.text();
    let parsed = null;

    try {
        parsed = JSON.parse(text);
    } catch {
        parsed = null;
    }

    return { status: response.status, headers: response.headers, text, json: parsed };
}

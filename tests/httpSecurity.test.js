// Pengujian Stage 2.3a: keamanan dasar HTTP (JSON guard, CORS allowlist, bind localhost).
// Server sungguhan dijalankan di port 3211-3213. Data uji sementara dihapus di akhir.
// CATATAN: ini BUKAN pengganti autentikasi.

import "dotenv/config";
import os from "node:os";
import net from "node:net";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import prisma from "../src/config/database.js";
import { startServer, call } from "./helpers/httpServer.js";

const ALLOWED = "http://localhost:5173";
const FOREIGN = "http://evil.example";

let user;
let wallet;
let cat;
let server; // CORS_ORIGINS=ALLOWED, bind default
let wideServer; // BIND_HOST=0.0.0.0 (hanya untuk memeriksa peringatan)

before(async () => {
    user = await prisma.user.create({ data: { name: "__test_sec_user__" } });
    wallet = await prisma.wallet.create({ data: { userId: user.id, name: "__test_wallet__", type: "CASH", initialBalance: 0 } });
    cat = await prisma.category.create({ data: { userId: null, name: "__test_sec_cat__", type: "INCOME" } });
    server = await startServer(3211, { DEFAULT_USER_ID: String(user.id), CORS_ORIGINS: ALLOWED, BIND_HOST: undefined });
});

after(async () => {
    server?.stop();
    wideServer?.stop();
    await prisma.transaction.deleteMany({ where: { userId: user.id } });
    await prisma.category.deleteMany({ where: { id: cat.id } });
    await prisma.user.deleteMany({ where: { id: user.id } });
    await prisma.$disconnect();
});

const body = () => ({ walletId: String(wallet.id), categoryId: String(cat.id), amount: "10.00", source: "WEB" });
const countTx = () => prisma.transaction.count({ where: { userId: user.id } });

describe("JSON guard (415)", () => {
    const attempts = {
        "tanpa Content-Type": async () =>
            fetch(`${server.base}/api/transactions/income`, { method: "POST" }),
        "application/x-www-form-urlencoded": async () =>
            fetch(`${server.base}/api/transactions/income`, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams(body()).toString(),
            }),
        "text/plain": async () =>
            fetch(`${server.base}/api/transactions/income`, {
                method: "POST",
                headers: { "Content-Type": "text/plain" },
                body: JSON.stringify(body()),
            }),
        "multipart/form-data": async () => {
            const form = new FormData();
            for (const [k, v] of Object.entries(body())) form.append(k, v);
            return fetch(`${server.base}/api/transactions/income`, { method: "POST", body: form });
        },
        "application/jsonx (mirip tapi bukan JSON)": async () =>
            fetch(`${server.base}/api/transactions/income`, {
                method: "POST",
                headers: { "Content-Type": "application/jsonx" },
                body: JSON.stringify(body()),
            }),
    };

    for (const [name, send] of Object.entries(attempts)) {
        test(`${name} -> 415 dan tidak ada transaksi dibuat`, async () => {
            const before = await countTx();
            const res = await send();
            assert.equal(res.status, 415);
            const json = await res.json();
            assert.equal(json.success, false);
            assert.equal(json.code, "UNSUPPORTED_MEDIA_TYPE");
            assert.equal(await countTx(), before);
        });
    }

    test("application/json (huruf besar + charset) diterima", async () => {
        const res = await call(server.base, "POST", "/api/transactions/income", {
            body: body(),
            headers: { "Content-Type": "Application/JSON; charset=UTF-8" },
        });
        assert.equal(res.status, 201, res.text);
    });

    test("GET tidak terkena JSON guard", async () => {
        assert.equal((await call(server.base, "GET", "/api/me")).status, 200);
    });

    test("POST tanpa body tetapi tanpa Content-Type JSON juga 415 (cegah form silang-situs tanpa isi)", async () => {
        const res = await fetch(`${server.base}/api/transactions/income`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
        });
        assert.equal(res.status, 415);
    });
});

describe("CORS allowlist", () => {
    const preflight = (origin) =>
        call(server.base, "OPTIONS", "/api/transactions/income", {
            headers: {
                Origin: origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        });

    test("preflight dari origin yang diizinkan mendapat Access-Control-Allow-Origin", async () => {
        const res = await preflight(ALLOWED);
        assert.equal(res.headers.get("access-control-allow-origin"), ALLOWED);
        assert.match(res.headers.get("access-control-allow-methods") ?? "", /POST/);
    });

    test("preflight dari origin asing TIDAK mendapat header CORS", async () => {
        const res = await preflight(FOREIGN);
        assert.equal(res.headers.get("access-control-allow-origin"), null);
        assert.equal(res.headers.get("access-control-allow-methods"), null);
    });

    test("request biasa dari origin diizinkan: header CORS ada", async () => {
        const res = await call(server.base, "GET", "/api/me", { headers: { Origin: ALLOWED } });
        assert.equal(res.headers.get("access-control-allow-origin"), ALLOWED);
    });

    test("request dari origin asing: tidak ada header CORS (browser tidak bisa membaca hasilnya)", async () => {
        const res = await call(server.base, "GET", "/api/me", { headers: { Origin: FOREIGN } });
        assert.equal(res.headers.get("access-control-allow-origin"), null);
    });

    test("tidak pernah memakai wildcard *", async () => {
        for (const origin of [ALLOWED, FOREIGN, "null"]) {
            const res = await call(server.base, "GET", "/api/me", { headers: { Origin: origin } });
            assert.notEqual(res.headers.get("access-control-allow-origin"), "*");
        }
    });

    test("tanpa header Origin (bot Telegram, curl) tetap dilayani", async () => {
        assert.equal((await call(server.base, "GET", "/api/me")).status, 200);
    });
});

describe("hanya mendengarkan di localhost", () => {
    const canConnect = (host, port) =>
        new Promise((resolve) => {
            const socket = net.connect({ host, port, timeout: 1500 });
            socket.once("connect", () => { socket.destroy(); resolve(true); });
            socket.once("timeout", () => { socket.destroy(); resolve(false); });
            socket.once("error", () => resolve(false));
        });

    test("default: log menyebut 127.0.0.1 dan tidak ada peringatan", () => {
        assert.match(server.output, /Server is running on http:\/\/127\.0\.0\.1:3211/);
        assert.doesNotMatch(server.output, /PERINGATAN/);
    });

    test("127.0.0.1 terjangkau", async () => {
        assert.equal(await canConnect("127.0.0.1", 3211), true);
    });

    test("::1 dan semua alamat IPv4 non-loopback milik mesin ini TIDAK terjangkau", async () => {
        assert.equal(await canConnect("::1", 3211), false);

        const external = Object.values(os.networkInterfaces())
            .flat()
            .filter((i) => i && i.family === "IPv4" && !i.internal)
            .map((i) => i.address);

        for (const address of external) {
            assert.equal(await canConnect(address, 3211), false, `${address} seharusnya tidak terjangkau`);
        }
    });

    test("BIND_HOST non-loopback menampilkan PERINGATAN autentikasi belum ada", async () => {
        wideServer = await startServer(3212, { DEFAULT_USER_ID: String(user.id), BIND_HOST: "0.0.0.0" });
        // console.warn masuk ke stderr; beri waktu singkat agar terbaca
        await new Promise((r) => setTimeout(r, 300));
        assert.match(wideServer.output, /PERINGATAN/);
        wideServer.stop();
        wideServer = null;
    });
});

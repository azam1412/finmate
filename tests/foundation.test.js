// Pengujian fondasi Fase 2 (langkah 2.1).
// Jalankan dengan: npm test
// Syarat: database MySQL menyala dan .env berisi DATABASE_URL.
// Tes ini membuat user & dompet SEMENTARA (nama diawali "__test_") lalu menghapusnya kembali,
// sehingga data asli Anda tidak tersentuh.

import "dotenv/config";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Prisma } from "@prisma/client";

import prisma from "../src/config/database.js";
import AppError from "../src/utils/AppError.js";
import { jsonReplacer } from "../src/utils/serialize.js";
import { parseId, parseMoney } from "../src/utils/validators.js";
import { runInTransaction, lockWallets } from "../src/utils/dbTransaction.js";

const APP_PATH = fileURLToPath(new URL("../src/app.js", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let userA;
let userB;
const servers = [];

function startServer(port, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [APP_PATH], {
            env: { ...process.env, PORT: String(port), ...env },
            stdio: ["ignore", "pipe", "pipe"],
        });
        servers.push(child);

        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`Server on port ${port} did not start in time`));
        }, 20000);

        child.stdout.on("data", (chunk) => {
            if (String(chunk).includes("Server is running")) {
                clearTimeout(timer);
                resolve(child);
            }
        });

        // Tampilkan error dari proses server anak
        child.stderr.on("data", (chunk) => {
            process.stderr.write(`[SERVER ${port}] ${chunk}`);
        });

        child.on("exit", (code) => {
            clearTimeout(timer);
            reject(new Error(`Server on port ${port} exited early with code ${code}`));
        });
    });
}

before(async () => {
    userA = await prisma.user.create({ data: { name: "__test_user_a__" } });
    userB = await prisma.user.create({ data: { name: "__test_user_b__" } });
});

after(async () => {
    for (const child of servers) {
        child.removeAllListeners("exit");
        child.kill();
    }
    // Menghapus user otomatis menghapus dompet miliknya (onDelete: Cascade)
    await prisma.user.deleteMany({ where: { id: { in: [userA.id, userB.id] } } });
    await prisma.$disconnect();
});

describe("serialisasi BigInt dan Decimal", () => {
    test("BigInt, Decimal, Date, dan nilai biasa diubah dengan benar", () => {
        const output = JSON.stringify(
            {
                id: 1n,
                list: [{ amount: new Prisma.Decimal("25000") }],
                when: new Date("2026-11-03T00:00:00.000Z"),
                count: 5,
                text: "x",
                empty: null,
            },
            jsonReplacer
        );

        assert.equal(
            output,
            '{"id":"1","list":[{"amount":"25000.00"}],"when":"2026-11-03T00:00:00.000Z","count":5,"text":"x","empty":null}'
        );
    });

    test("BigInt yang sangat besar tidak kehilangan presisi", () => {
        assert.equal(JSON.stringify({ id: 9223372036854775807n }, jsonReplacer), '{"id":"9223372036854775807"}');
    });
});

describe("validators", () => {
    test("parseMoney menerima nominal valid sebagai Decimal", () => {
        assert.ok(Prisma.Decimal.isDecimal(parseMoney("25000")));
        assert.equal(parseMoney("25000.50").toFixed(2), "25000.50");
        assert.equal(parseMoney(25000).toFixed(2), "25000.00");
        assert.equal(parseMoney("9999999999999.99").toFixed(2), "9999999999999.99");
    });

    test("parseMoney menolak nominal tidak valid", () => {
        for (const bad of ["0", "0.00", "-5", "abc", "", "1e3", "12.345", 0.1 + 0.2, NaN, null, undefined, {}, "10000000000000"]) {
            assert.throws(() => parseMoney(bad), (err) => err instanceof AppError && err.statusCode === 400, `harus menolak: ${String(bad)}`);
        }
    });

    test("parseId menghasilkan BigInt dan menolak input tidak valid", () => {
        assert.equal(parseId("42"), 42n);
        assert.equal(parseId(7), 7n);
        for (const bad of ["0", "-1", "1.5", "abc", "", null, undefined, "9223372036854775808", 1.5]) {
            assert.throws(() => parseId(bad), (err) => err instanceof AppError && err.statusCode === 400, `harus menolak: ${String(bad)}`);
        }
    });
});

describe("API: userContext dan error handler", () => {
    let base;

    before(async () => {
        await startServer(3101, { DEFAULT_USER_ID: String(userA.id) });
        base = "http://127.0.0.1:3101";
    });

    test("GET / dan GET /health tetap berfungsi", async () => {
        assert.equal((await fetch(`${base}/`)).status, 200);
        const health = await fetch(`${base}/health`);
        assert.equal(health.status, 200);
        assert.equal((await health.json()).success, true);
    });

    test("GET /api/me mengembalikan user dari DEFAULT_USER_ID dengan id berupa string", async () => {
        const res = await fetch(`${base}/api/me`);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.success, true);
        assert.equal(typeof body.data.id, "string");
        assert.equal(body.data.id, String(userA.id));
        assert.equal(body.data.name, "__test_user_a__");
    });

    test("userId dari header atau query tidak bisa menimpa req.user", async () => {
        const res = await fetch(`${base}/api/me?userId=${userB.id}`, {
            headers: { "x-user-id": String(userB.id) },
        });
        const body = await res.json();
        assert.equal(body.data.id, String(userA.id));
    });

    test("route yang tidak ada menghasilkan 404 JSON", async () => {
        for (const path of ["/tidak-ada", "/api/tidak-ada"]) {
            const res = await fetch(`${base}${path}`);
            assert.equal(res.status, 404);
            const body = await res.json();
            assert.equal(body.success, false);
            assert.equal(body.code, "ROUTE_NOT_FOUND");
        }
    });

    test("body JSON rusak menghasilkan 400 INVALID_JSON (bukan stack trace)", async () => {
        const res = await fetch(`${base}/api/me`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{rusak",
        });
        assert.equal(res.status, 400);
        const body = await res.json();
        assert.equal(body.code, "INVALID_JSON");
        assert.equal(JSON.stringify(body).includes("at "), false);
    });

    test("DEFAULT_USER_ID tidak valid menghasilkan 500 USER_CONTEXT_NOT_CONFIGURED", async () => {
        await startServer(3102, { DEFAULT_USER_ID: "abc" });
        const res = await fetch("http://127.0.0.1:3102/api/me");
        assert.equal(res.status, 500);
        assert.equal((await res.json()).code, "USER_CONTEXT_NOT_CONFIGURED");
    });

    test("DEFAULT_USER_ID kosong menghasilkan 500 USER_CONTEXT_NOT_CONFIGURED", async () => {
        await startServer(3103, { DEFAULT_USER_ID: "" });
        const res = await fetch("http://127.0.0.1:3103/api/me");
        assert.equal(res.status, 500);
        assert.equal((await res.json()).code, "USER_CONTEXT_NOT_CONFIGURED");
    });

    test("DEFAULT_USER_ID yang tidak ada di database menghasilkan 401 USER_NOT_FOUND", async () => {
        await startServer(3104, { DEFAULT_USER_ID: "999999999" });
        const res = await fetch("http://127.0.0.1:3104/api/me");
        assert.equal(res.status, 401);
        assert.equal((await res.json()).code, "USER_NOT_FOUND");
    });
});

describe("lockWallets dan runInTransaction (race condition)", () => {
    // Dompet "penghitung": initialBalance dipakai sebagai saldo uji, karena tabel transaksi
    // belum punya logika saldo. Setiap "pengeluaran" membaca saldo, menunggu sebentar
    // (memperbesar peluang tabrakan), lalu menulis saldo baru jika cukup.
    async function spend(walletId, amount, useLock) {
        return runInTransaction(async (tx) => {
            if (useLock) {
                await lockWallets(tx, userA.id, [walletId]);
            }
            const wallet = await tx.wallet.findUnique({ where: { id: walletId } });
            await sleep(50);

            const newBalance = wallet.initialBalance.minus(amount);
            if (newBalance.lt(0)) {
                throw new AppError(422, "INSUFFICIENT_BALANCE", "Insufficient balance");
            }
            await tx.wallet.update({ where: { id: walletId }, data: { initialBalance: newBalance } });
        });
    }

    async function newCounterWallet(initial) {
        return prisma.wallet.create({
            data: { userId: userA.id, name: "__test_counter__", type: "CASH", initialBalance: initial },
        });
    }

    test("KONTROL tanpa lock: tabrakan terjadi (hanya informasi, tidak di-assert)", async (t) => {
        const wallet = await newCounterWallet(100);
        const results = await Promise.allSettled([1, 2, 3, 4, 5].map(() => spend(wallet.id, 30, false)));
        const ok = results.filter((r) => r.status === "fulfilled").length;
        const final = (await prisma.wallet.findUnique({ where: { id: wallet.id } })).initialBalance.toFixed(2);
        t.diagnostic(`tanpa lock: ${ok} dari 5 pengeluaran Rp30 lolos dari saldo Rp100, saldo akhir ${final} (seharusnya 3 lolos dan sisa 10.00)`);
    });

    test("dengan lock: 5 pengeluaran Rp30 bersamaan dari saldo Rp100 -> tepat 3 lolos, saldo akhir 10", async () => {
        const wallet = await newCounterWallet(100);
        const results = await Promise.allSettled([1, 2, 3, 4, 5].map(() => spend(wallet.id, 30, true)));

        const fulfilled = results.filter((r) => r.status === "fulfilled");
        const rejected = results.filter((r) => r.status === "rejected");

        assert.equal(fulfilled.length, 3);
        assert.equal(rejected.length, 2);
        for (const r of rejected) {
            assert.equal(r.reason.code, "INSUFFICIENT_BALANCE");
        }

        const final = await prisma.wallet.findUnique({ where: { id: wallet.id } });
        assert.equal(final.initialBalance.toFixed(2), "10.00");
    });

    test("tidak deadlock: transfer A->B dan B->A bersamaan semuanya selesai", async () => {
        const walletA = await newCounterWallet(0);
        const walletB = await newCounterWallet(0);

        const jobs = Array.from({ length: 10 }, (_, i) =>
            runInTransaction(async (tx) => {
                const order = i % 2 === 0 ? [walletA.id, walletB.id] : [walletB.id, walletA.id];
                await lockWallets(tx, userA.id, order);
                await sleep(20);
            })
        );

        const results = await Promise.allSettled(jobs);
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 10);
    });

    test("dompet milik user lain atau yang tidak ada ditolak dengan 404 yang sama", async () => {
        const walletOfB = await prisma.wallet.create({
            data: { userId: userB.id, name: "__test_b__", type: "BANK" },
        });

        for (const walletId of [walletOfB.id, 999999999n]) {
            await assert.rejects(
                runInTransaction((tx) => lockWallets(tx, userA.id, [walletId])),
                (err) => err instanceof AppError && err.statusCode === 404 && err.code === "WALLET_NOT_FOUND"
            );
        }
    });

    test("dompet nonaktif ditolak (422), kecuali requireActive: false", async () => {
        const inactive = await prisma.wallet.create({
            data: { userId: userA.id, name: "__test_inactive__", type: "CASH", isActive: false },
        });

        await assert.rejects(
            runInTransaction((tx) => lockWallets(tx, userA.id, [inactive.id])),
            (err) => err instanceof AppError && err.statusCode === 422 && err.code === "WALLET_INACTIVE"
        );

        const wallets = await runInTransaction((tx) =>
            lockWallets(tx, userA.id, [inactive.id], { requireActive: false })
        );
        assert.equal(wallets.length, 1);
        assert.equal(wallets[0].isActive, false);
        assert.equal(typeof wallets[0].id, "bigint");
        assert.ok(Prisma.Decimal.isDecimal(wallets[0].initialBalance));
    });

    test("id dompet duplikat tidak membuat error dan hasilnya terurut", async () => {
        const w1 = await newCounterWallet(0);
        const w2 = await newCounterWallet(0);
        const wallets = await runInTransaction((tx) => lockWallets(tx, userA.id, [w2.id, w1.id, w2.id]));
        assert.deepEqual(wallets.map((w) => w.id), [w1.id, w2.id].sort((a, b) => (a < b ? -1 : 1)));
    });
});

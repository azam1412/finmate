// Pengujian Stage 2.3a: endpoint HTTP pembuatan transaksi.
//   POST /api/transactions/income | /expense | /transfer
// Jalankan dengan: npm test
// Tes menjalankan server sungguhan (src/app.js) di port 3201-3202 dan membuat user, dompet,
// dan kategori SEMENTARA (nama diawali "__test_") yang dihapus kembali di akhir.

import "dotenv/config";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import prisma from "../src/config/database.js";
import { getWalletBalances } from "../src/services/balanceService.js";
import { startServer, call } from "./helpers/httpServer.js";

let userA;
let userB;
let serverA; // DEFAULT_USER_ID = userA
let serverB; // DEFAULT_USER_ID = userB
let incomeCat;
let expenseCat;
let walletA1;
let walletA2;
let walletB1;
let inactiveWalletA;
let ownExpenseCat; // kategori EXPENSE milik user B

before(async () => {
    userA = await prisma.user.create({ data: { name: "__test_http_a__" } });
    userB = await prisma.user.create({ data: { name: "__test_http_b__" } });
    incomeCat = await prisma.category.create({ data: { userId: null, name: "__test_http_income__", type: "INCOME" } });
    expenseCat = await prisma.category.create({ data: { userId: null, name: "__test_http_expense__", type: "EXPENSE" } });
    ownExpenseCat = await prisma.category.create({ data: { userId: userB.id, name: "__test_http_b_cat__", type: "EXPENSE" } });

    const mk = (user, extra = {}) =>
        prisma.wallet.create({ data: { userId: user.id, name: "__test_wallet__", type: "CASH", initialBalance: 1000, ...extra } });

    walletA1 = await mk(userA);
    walletA2 = await mk(userA);
    inactiveWalletA = await mk(userA, { isActive: false });
    walletB1 = await mk(userB);

    serverA = await startServer(3201, { DEFAULT_USER_ID: String(userA.id) });
    serverB = await startServer(3202, { DEFAULT_USER_ID: String(userB.id) });
});

after(async () => {
    serverA?.stop();
    serverB?.stop();
    const userIds = [userA.id, userB.id];
    await prisma.transaction.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.category.deleteMany({ where: { id: { in: [incomeCat.id, expenseCat.id, ownExpenseCat.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
});

// ---------- helper ----------

const incomeBody = (overrides = {}) => ({
    walletId: String(walletA1.id),
    categoryId: String(incomeCat.id),
    amount: "50000.00",
    source: "WEB",
    ...overrides,
});

const expenseBody = (overrides = {}) => ({
    walletId: String(walletA1.id),
    categoryId: String(expenseCat.id),
    amount: "1500.50",
    source: "WEB",
    ...overrides,
});

const transferBody = (overrides = {}) => ({
    walletId: String(walletA1.id),
    destinationWalletId: String(walletA2.id),
    amount: "250.00",
    source: "WEB",
    ...overrides,
});

const post = (server, path, body, headers) => call(server.base, "POST", `/api/transactions/${path}`, { body, headers });
const countTx = (userId) => prisma.transaction.count({ where: { userId } });
const key = () => `k-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

function assertError(res, status, code) {
    assert.equal(res.status, status, `status ${res.status}: ${res.text}`);
    assert.equal(res.json?.success, false);
    assert.equal(res.json?.code, code);
}

// ---------- jalur sukses ----------

describe("POST /api/transactions/income", () => {
    test("201: transaksi PENDING dibuat, id dan amount berupa string, tanpa userId", async () => {
        const res = await post(serverA, "income", incomeBody({ description: "Gaji" }));
        assert.equal(res.status, 201, res.text);
        assert.equal(res.json.success, true);
        assert.equal(res.json.created, true);

        const t = res.json.data;
        assert.equal(typeof t.id, "string");
        assert.match(t.id, /^[1-9]\d*$/);
        assert.equal(t.type, "INCOME");
        assert.equal(t.status, "PENDING");
        assert.equal(t.amount, "50000.00");
        assert.equal(t.walletId, String(walletA1.id));
        assert.equal(t.categoryId, String(incomeCat.id));
        assert.equal(t.description, "Gaji");
        assert.equal(Object.hasOwn(t, "userId"), false, "userId tidak boleh bocor");

        const row = await prisma.transaction.findUnique({ where: { id: BigInt(t.id) } });
        assert.equal(row.userId, userA.id);
        assert.equal(row.status, "PENDING");
    });

    test("saldo tidak berubah karena transaksi masih PENDING", async () => {
        const wallet = await prisma.wallet.create({
            data: { userId: userA.id, name: "__test_wallet__", type: "CASH", initialBalance: 1000 },
        });
        const res = await post(serverA, "income", incomeBody({ walletId: String(wallet.id) }));
        assert.equal(res.status, 201, res.text);

        const balances = await getWalletBalances(prisma, userA.id, [wallet.id]);
        assert.equal(balances.get(wallet.id).balance.toFixed(2), "1000.00");
    });

    test("Content-Type dengan charset diterima", async () => {
        const res = await post(serverA, "income", incomeBody(), { "Content-Type": "application/json; charset=utf-8" });
        assert.equal(res.status, 201, res.text);
    });
});

describe("POST /api/transactions/expense", () => {
    test("201: EXPENSE PENDING dibuat (saldo tidak dicek saat pembuatan)", async () => {
        const res = await post(serverA, "expense", expenseBody({ amount: "999999.99" }));
        assert.equal(res.status, 201, res.text);
        assert.equal(res.json.data.type, "EXPENSE");
        assert.equal(res.json.data.status, "PENDING");
        assert.equal(res.json.data.amount, "999999.99");
        assert.equal(Object.hasOwn(res.json.data, "userId"), false);
    });
});

describe("POST /api/transactions/transfer", () => {
    test("201: TRANSFER PENDING dengan dompet sumber dan tujuan", async () => {
        const res = await post(serverA, "transfer", transferBody());
        assert.equal(res.status, 201, res.text);
        const t = res.json.data;
        assert.equal(t.type, "TRANSFER");
        assert.equal(t.status, "PENDING");
        assert.equal(t.walletId, String(walletA1.id));
        assert.equal(t.destinationWalletId, String(walletA2.id));
        assert.equal(t.categoryId, null);
        assert.equal(t.amount, "250.00");
        assert.equal(Object.hasOwn(t, "userId"), false);
    });

    test("422 TRANSFER_SAME_WALLET untuk dompet sumber = tujuan", async () => {
        const before = await countTx(userA.id);
        const res = await post(serverA, "transfer", transferBody({ destinationWalletId: String(walletA1.id) }));
        assertError(res, 422, "TRANSFER_SAME_WALLET");
        assert.equal(await countTx(userA.id), before);
    });

    test("400: categoryId pada TRANSFER ditolak", async () => {
        const res = await post(serverA, "transfer", transferBody({ categoryId: String(expenseCat.id) }));
        assertError(res, 400, "VALIDATION_ERROR");
    });

    test("404: dompet tujuan milik user lain", async () => {
        const res = await post(serverA, "transfer", transferBody({ destinationWalletId: String(walletB1.id) }));
        assertError(res, 404, "WALLET_NOT_FOUND");
    });

    test("422 WALLET_INACTIVE untuk dompet tujuan nonaktif", async () => {
        const res = await post(serverA, "transfer", transferBody({ destinationWalletId: String(inactiveWalletA.id) }));
        assertError(res, 422, "WALLET_INACTIVE");
    });
});

// ---------- idempotensi ----------

describe("idempotencyKey lewat HTTP", () => {
  for (const [path, build] of [
    ["income", incomeBody],
    ["expense", expenseBody],
    ["transfer", transferBody],
  ]) {
    test(`${path}: permintaan ulang yang sama -> 200 created:false, transaksi yang sama, tidak ada duplikat`, async () => {
        const idempotencyKey = key();
        const before = await countTx(userA.id);

        const first = await post(serverA, path, build({ idempotencyKey }));
        assert.equal(first.status, 201, first.text);
        assert.equal(first.json.data.idempotencyKey, idempotencyKey, "kunci dikembalikan tanpa awalan userId");

        const second = await post(serverA, path, build({ idempotencyKey }));
        assert.equal(second.status, 200, second.text);
        assert.equal(second.json.created, false);
        assert.equal(second.json.data.id, first.json.data.id);

        assert.equal(await countTx(userA.id), before + 1);
    });
  }

    test("kunci sama dengan isi berbeda -> 409 IDEMPOTENCY_CONFLICT", async () => {
        const idempotencyKey = key();
        assert.equal((await post(serverA, "expense", expenseBody({ idempotencyKey }))).status, 201);
        const res = await post(serverA, "expense", expenseBody({ idempotencyKey, amount: "9.99" }));
        assertError(res, 409, "IDEMPOTENCY_CONFLICT");
    });

    test("8 permintaan bersamaan dengan kunci yang sama -> tepat satu 201, sisanya 200, satu baris di database", async () => {
        const idempotencyKey = key();
        const results = await Promise.all(
            Array.from({ length: 8 }, () => post(serverA, "income", incomeBody({ idempotencyKey })))
        );

        const statuses = results.map((r) => r.status).sort();
        assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 200, 201], JSON.stringify(results.map((r) => r.text)));
        assert.equal(new Set(results.map((r) => r.json.data.id)).size, 1);

        const rows = await prisma.transaction.count({ where: { userId: userA.id, idempotencyKey: `${userA.id}:${idempotencyKey}` } });
        assert.equal(rows, 1);
    });

    test("kunci yang sama dipakai dua user berbeda tidak bertabrakan", async () => {
        const idempotencyKey = key();
        const a = await post(serverA, "income", incomeBody({ idempotencyKey }));
        const b = await post(
            serverB,
            "expense",
            { walletId: String(walletB1.id), categoryId: String(expenseCat.id), amount: "5.00", source: "WEB", idempotencyKey }
        );
        assert.equal(a.status, 201, a.text);
        assert.equal(b.status, 201, b.text);
        assert.notEqual(a.json.data.id, b.json.data.id);
    });
});

// ---------- keamanan identitas dan isolasi data ----------

describe("userId dan field terlarang tidak bisa dikirim klien", () => {
    for (const field of ["userId", "status", "type", "id", "createdAt"]) {
        test(`field "${field}" di body ditolak 400 dan tidak ada transaksi dibuat`, async () => {
            const before = await countTx(userA.id);
            const res = await post(serverA, "income", incomeBody({ [field]: field === "userId" ? String(userB.id) : "CONFIRMED" }));
            assertError(res, 400, "VALIDATION_ERROR");
            assert.equal(await countTx(userA.id), before);
        });
    }

    test("header X-User-Id dan query ?userId diabaikan: transaksi tetap milik user dari server", async () => {
        const res = await call(serverA.base, "POST", `/api/transactions/income?userId=${userB.id}`, {
            body: incomeBody(),
            headers: { "X-User-Id": String(userB.id) },
        });
        assert.equal(res.status, 201, res.text);
        const row = await prisma.transaction.findUnique({ where: { id: BigInt(res.json.data.id) } });
        assert.equal(row.userId, userA.id);
    });

    test("user A tidak bisa memakai dompet atau kategori milik user B (404, tanpa membuat data)", async () => {
        const before = await countTx(userA.id);
        assertError(await post(serverA, "income", incomeBody({ walletId: String(walletB1.id) })), 404, "WALLET_NOT_FOUND");
        assertError(await post(serverA, "expense", expenseBody({ categoryId: String(ownExpenseCat.id) })), 404, "CATEGORY_NOT_FOUND");
        assert.equal(await countTx(userA.id), before);
    });

    test("server user B hanya membuat transaksi milik user B pada dompetnya sendiri", async () => {
        const res = await post(serverB, "expense", { walletId: String(walletB1.id), categoryId: String(ownExpenseCat.id), amount: "1.00", source: "WEB" });
        assert.equal(res.status, 201, res.text);
        const row = await prisma.transaction.findUnique({ where: { id: BigInt(res.json.data.id) } });
        assert.equal(row.userId, userB.id);

        assertError(await post(serverB, "income", incomeBody()), 404, "WALLET_NOT_FOUND");
    });
});

// ---------- validasi ----------

describe("validasi input", () => {
    test("nominal tidak valid -> 400", async () => {
        for (const amount of ["0", "-5", "abc", "12.345", "", null, 1e3.toString() + "e"]) {
            const res = await post(serverA, "income", incomeBody({ amount }));
            assertError(res, 400, "VALIDATION_ERROR");
        }
    });

    test("field wajib hilang -> 400", async () => {
        for (const field of ["walletId", "categoryId", "amount", "source"]) {
            const body = incomeBody();
            delete body[field];
            assertError(await post(serverA, "income", body), 400, "VALIDATION_ERROR");
        }
    });

    test("JSON rusak -> 400 INVALID_JSON", async () => {
        assertError(await post(serverA, "income", "{ ini bukan json"), 400, "INVALID_JSON");
    });

    test("body bukan objek (array, null, string, angka) -> 400", async () => {
        assertError(await post(serverA, "income", "[]"), 400, "VALIDATION_ERROR");
        assertError(await post(serverA, "income", "null"), 400, "INVALID_JSON");
        assertError(await post(serverA, "income", '"abc"'), 400, "INVALID_JSON");
    });

    test("tanpa body (Content-Type JSON, isi kosong) -> 400", async () => {
        const res = await call(serverA.base, "POST", "/api/transactions/income", { headers: { "Content-Type": "application/json" } });
        assertError(res, 400, "VALIDATION_ERROR");
    });

    test("body lebih dari 1 MB -> 413 PAYLOAD_TOO_LARGE", async () => {
        const res = await post(serverA, "income", incomeBody({ description: "x".repeat(1_100_000) }));
        assertError(res, 413, "PAYLOAD_TOO_LARGE");
    });

    test("tipe kategori tidak cocok -> 422 CATEGORY_TYPE_MISMATCH", async () => {
        assertError(await post(serverA, "income", incomeBody({ categoryId: String(expenseCat.id) })), 422, "CATEGORY_TYPE_MISMATCH");
        assertError(await post(serverA, "expense", expenseBody({ categoryId: String(incomeCat.id) })), 422, "CATEGORY_TYPE_MISMATCH");
    });

    test("nominal dikirim sebagai angka JSON juga diterima dan tidak kehilangan presisi", async () => {
        const res = await post(serverA, "income", incomeBody({ amount: 12.5 }));
        assert.equal(res.status, 201, res.text);
        assert.equal(res.json.data.amount, "12.50");
    });
});

// ---------- route lain ----------

describe("route", () => {
    test("route yang belum dibuat -> 404 ROUTE_NOT_FOUND (list/detail baru ada di 2.3c; confirm/cancel diuji di httpTransactionLifecycle)", async () => {
        for (const [method, path] of [
            ["GET", "/api/transactions"],
            ["GET", "/api/transactions/1"],
            ["POST", "/api/transactions/unknown"],
        ]) {
            const res = await call(serverA.base, method, path, method === "POST" ? { body: {} } : {});
            assertError(res, 404, "ROUTE_NOT_FOUND");
        }
    });

    test("GET /, /health, dan /api/me tetap berfungsi", async () => {
        assert.equal((await call(serverA.base, "GET", "/")).status, 200);
        assert.equal((await call(serverA.base, "GET", "/health")).status, 200);
        const me = await call(serverA.base, "GET", "/api/me");
        assert.equal(me.status, 200);
        assert.equal(me.json.data.id, String(userA.id));
    });
});

// Pengujian Stage 2.3c (level service): listTransactions dan getTransaction.
// Jalankan dengan: npm test
// Tes membuat user, dompet, kategori, dan transaksi SEMENTARA (nama diawali "__test_") lalu
// menghapusnya kembali. Data seed milik Anda tidak disentuh.

import "dotenv/config";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import prisma from "../src/config/database.js";
import AppError from "../src/utils/AppError.js";
import { listTransactions, getTransaction } from "../src/services/transactionQueryService.js";

let userA;
let userB;
let userEmpty;
let userTie;
let wA1;
let wA2;
let wA3;
let wB1;
let incomeCat;
let expenseCat;
const t = {}; // t1..t7 milik user A (id BigInt)
let bRowIds = [];

const D = (s) => new Date(s);

async function mk(user, wallet, props) {
    const row = await prisma.transaction.create({
        data: {
            userId: user.id,
            walletId: wallet.id,
            amount: "100.00",
            transactionDate: D("2026-01-01T00:00:00Z"),
            ...props,
        },
    });
    return row.id;
}

before(async () => {
    userA = await prisma.user.create({ data: { name: "__test_query_a__" } });
    userB = await prisma.user.create({ data: { name: "__test_query_b__" } });
    userEmpty = await prisma.user.create({ data: { name: "__test_query_empty__" } });
    userTie = await prisma.user.create({ data: { name: "__test_query_tie__" } });

    const wallet = (user) => prisma.wallet.create({ data: { userId: user.id, name: "__test_wallet__", type: "CASH", initialBalance: 0 } });
    wA1 = await wallet(userA);
    wA2 = await wallet(userA);
    wA3 = await wallet(userA);
    wB1 = await wallet(userB);

    incomeCat = await prisma.category.create({ data: { userId: null, name: "__test_query_income__", type: "INCOME" } });
    expenseCat = await prisma.category.create({ data: { userId: null, name: "__test_query_expense__", type: "EXPENSE" } });

    // Data user A (tanggal berurutan agar urutan hasil mudah diprediksi)
    t.t1 = await mk(userA, wA1, { type: "INCOME", status: "CONFIRMED", source: "WEB", categoryId: incomeCat.id, transactionDate: D("2026-01-10T00:00:00Z") });
    t.t2 = await mk(userA, wA1, { type: "EXPENSE", status: "CONFIRMED", source: "TELEGRAM", categoryId: expenseCat.id, transactionDate: D("2026-02-10T00:00:00Z") });
    t.t3 = await mk(userA, wA2, { type: "EXPENSE", status: "PENDING", source: "WEB", categoryId: expenseCat.id, transactionDate: D("2026-03-10T00:00:00Z") });
    t.t4 = await mk(userA, wA1, { type: "TRANSFER", status: "CONFIRMED", source: "TELEGRAM", destinationWalletId: wA2.id, transactionDate: D("2026-04-10T00:00:00Z") });
    t.t5 = await mk(userA, wA3, { type: "TRANSFER", status: "PENDING", source: "WHATSAPP", destinationWalletId: wA1.id, transactionDate: D("2026-05-10T00:00:00Z") });
    t.t6 = await mk(userA, wA2, { type: "INCOME", status: "CANCELLED", source: "WHATSAPP", categoryId: incomeCat.id, transactionDate: D("2026-06-10T00:00:00Z") });
    t.t7 = await mk(userA, wA3, { type: "EXPENSE", status: "CONFIRMED", source: "WEB", categoryId: expenseCat.id, transactionDate: D("2026-07-10T00:00:00Z") });

    // Data user B dengan atribut yang sama (tidak boleh pernah muncul di hasil user A)
    bRowIds = [
        await mk(userB, wB1, { type: "INCOME", status: "CONFIRMED", source: "WEB", categoryId: incomeCat.id, transactionDate: D("2026-01-10T00:00:00Z") }),
        await mk(userB, wB1, { type: "EXPENSE", status: "PENDING", source: "WEB", categoryId: expenseCat.id, transactionDate: D("2026-08-10T00:00:00Z") }),
    ];

    // Enam transaksi user "tie" dengan transactionDate PERSIS sama (menguji tie-breaker id)
    const w = await wallet(userTie);
    for (let i = 0; i < 6; i++) {
        await mk(userTie, w, { type: "INCOME", status: "CONFIRMED", source: "WEB", categoryId: incomeCat.id, transactionDate: D("2026-09-09T09:09:09Z") });
    }
});

after(async () => {
    const userIds = [userA.id, userB.id, userEmpty.id, userTie.id];
    await prisma.transaction.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.category.deleteMany({ where: { id: { in: [incomeCat.id, expenseCat.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
});

// ---------- helper ----------

const ids = (result) => result.transactions.map((x) => x.id);
const expectIds = (result, ...keys) => assert.deepEqual(ids(result), keys.map((k) => t[k]));
const list = (query = {}, user = userA) => listTransactions(user.id, query);

function rejects400(promise, field) {
    return assert.rejects(promise, (err) => {
        assert.ok(err instanceof AppError, `bukan AppError: ${err?.stack ?? err}`);
        assert.equal(err.statusCode, 400);
        assert.equal(err.code, "VALIDATION_ERROR");
        if (field) assert.equal(err.details?.field, field);
        return true;
    });
}

// ---------- daftar ----------

describe("listTransactions: dasar", () => {
    test("tanpa filter: semua milik user, terbaru dulu, default page=1 limit=20", async () => {
        const r = await list();
        expectIds(r, "t7", "t6", "t5", "t4", "t3", "t2", "t1");
        assert.deepEqual(r.pagination, { page: 1, limit: 20, total: 7, totalPages: 1 });
    });

    test("user tanpa transaksi: daftar kosong, total 0, totalPages 0", async () => {
        const r = await list({}, userEmpty);
        assert.deepEqual(r.transactions, []);
        assert.deepEqual(r.pagination, { page: 1, limit: 20, total: 0, totalPages: 0 });
    });

    test("bentuk baris: Decimal tetap Decimal, id BigInt (serialisasi ke string dilakukan app.js)", async () => {
        const [row] = (await list({ limit: "1" })).transactions;
        assert.equal(typeof row.id, "bigint");
        assert.equal(row.amount.toFixed(2), "100.00");
        assert.equal(row.status, "CONFIRMED");
    });
});

describe("listTransactions: filter tunggal", () => {
    test("type", async () => {
        expectIds(await list({ type: "INCOME" }), "t6", "t1");
        expectIds(await list({ type: "TRANSFER" }), "t5", "t4");
        expectIds(await list({ type: "EXPENSE" }), "t7", "t3", "t2");
    });

    test("status", async () => {
        expectIds(await list({ status: "PENDING" }), "t5", "t3");
        expectIds(await list({ status: "CANCELLED" }), "t6");
        expectIds(await list({ status: "CONFIRMED" }), "t7", "t4", "t2", "t1");
    });

    test("source", async () => {
        expectIds(await list({ source: "WHATSAPP" }), "t6", "t5");
        expectIds(await list({ source: "TELEGRAM" }), "t4", "t2");
        expectIds(await list({ source: "WEB" }), "t7", "t3", "t1");
    });

    test("categoryId: hanya transaksi berkategori tersebut (TRANSFER tidak pernah cocok)", async () => {
        expectIds(await list({ categoryId: String(expenseCat.id) }), "t7", "t3", "t2");
        expectIds(await list({ categoryId: String(incomeCat.id) }), "t6", "t1");
    });

    test("walletId: transaksi biasa pada dompet itu", async () => {
        expectIds(await list({ walletId: String(wA2.id) }), "t6", "t4", "t3"); // t4 = tujuan transfer
    });

    test("walletId: TRANSFER ditemukan baik saat dompet menjadi SUMBER maupun TUJUAN", async () => {
        // wA1: sumber t4, tujuan t5, plus t2 dan t1
        expectIds(await list({ walletId: String(wA1.id) }), "t5", "t4", "t2", "t1");
        // wA3: sumber t5 dan sumber t7
        expectIds(await list({ walletId: String(wA3.id) }), "t7", "t5");
        // wA2: hanya TUJUAN pada t4
        const r = await list({ walletId: String(wA2.id), type: "TRANSFER" });
        expectIds(r, "t4");
    });
});

describe("listTransactions: kombinasi filter", () => {
    test("filter digabung dengan AND", async () => {
        expectIds(await list({ status: "CONFIRMED", type: "EXPENSE" }), "t7", "t2");
        expectIds(await list({ walletId: String(wA1.id), status: "CONFIRMED" }), "t4", "t2", "t1");
        expectIds(await list({ walletId: String(wA1.id), type: "TRANSFER" }), "t5", "t4");
        expectIds(await list({ source: "WEB", status: "PENDING", type: "EXPENSE", categoryId: String(expenseCat.id) }), "t3");
    });

    test("TRANSFER + categoryId menghasilkan daftar kosong (bukan error)", async () => {
        const r = await list({ type: "TRANSFER", categoryId: String(expenseCat.id) });
        assert.deepEqual(r.transactions, []);
        assert.equal(r.pagination.total, 0);
    });

    test("kombinasi yang tidak cocok apa pun: kosong", async () => {
        const r = await list({ type: "INCOME", status: "PENDING" });
        assert.deepEqual(r.transactions, []);
    });
});

describe("listTransactions: rentang tanggal (from dan to inklusif)", () => {
    test("from inklusif: transaksi tepat pada from ikut", async () => {
        expectIds(await list({ from: "2026-05-10T00:00:00Z" }), "t7", "t6", "t5");
    });

    test("to inklusif: transaksi tepat pada to ikut", async () => {
        expectIds(await list({ to: "2026-02-10T00:00:00Z" }), "t2", "t1");
    });

    test("1 milidetik di luar batas tidak ikut", async () => {
        expectIds(await list({ from: "2026-05-10T00:00:00.001Z" }), "t7", "t6");
        expectIds(await list({ to: "2026-02-09T23:59:59.999Z" }), "t1");
    });

    test("from dan to bersama, dengan zona waktu berbeda yang setara", async () => {
        expectIds(await list({ from: "2026-03-10T07:00:00+07:00", to: "2026-05-10T00:00:00Z" }), "t5", "t4", "t3");
    });

    test("from = to menemukan transaksi pada instan itu", async () => {
        expectIds(await list({ from: "2026-04-10T00:00:00Z", to: "2026-04-10T00:00:00Z" }), "t4");
    });

    test("rentang dikombinasikan dengan filter lain", async () => {
        expectIds(await list({ from: "2026-03-01T00:00:00Z", status: "CONFIRMED" }), "t7", "t4");
    });

    test("from lebih besar dari to ditolak 400", async () => {
        await rejects400(list({ from: "2026-06-01T00:00:00Z", to: "2026-05-01T00:00:00Z" }), "from");
    });

    test("tanggal tanpa zona waktu, hanya tanggal, tidak valid, atau '+' yang jadi spasi ditolak", async () => {
        for (const value of ["2026-05-10", "2026-05-10T00:00:00", "2026-13-10T00:00:00Z", "2026-02-30T00:00:00Z", "1999-01-01T00:00:00Z", "2026-05-10T00:00:00 07:00", "kemarin"]) {
            await rejects400(list({ from: value }), "from");
            await rejects400(list({ to: value }), "to");
        }
    });
});

describe("listTransactions: walletId dan categoryId yang tidak ditemukan", () => {
    test("dompet milik user lain, dompet tidak ada, kategori tidak ada: daftar kosong tanpa error", async () => {
        for (const query of [{ walletId: String(wB1.id) }, { walletId: "999999999999" }, { categoryId: "999999999999" }]) {
            const r = await list(query);
            assert.deepEqual(r.transactions, [], JSON.stringify(query));
            assert.equal(r.pagination.total, 0);
        }
    });
});

describe("listTransactions: pagination dan urutan", () => {
    test("halaman berurutan tanpa baris ganda atau hilang", async () => {
        const p1 = await list({ limit: "3", page: "1" });
        const p2 = await list({ limit: "3", page: "2" });
        const p3 = await list({ limit: "3", page: "3" });
        expectIds(p1, "t7", "t6", "t5");
        expectIds(p2, "t4", "t3", "t2");
        expectIds(p3, "t1");
        for (const p of [p1, p2, p3]) assert.deepEqual(p.pagination.total, 7);
        assert.deepEqual(p1.pagination, { page: 1, limit: 3, total: 7, totalPages: 3 });
    });

    test("halaman melewati akhir: kosong, tetapi pagination tetap benar", async () => {
        const r = await list({ limit: "3", page: "4" });
        assert.deepEqual(r.transactions, []);
        assert.deepEqual(r.pagination, { page: 4, limit: 3, total: 7, totalPages: 3 });
    });

    test("batas: limit=100 dan page=10000 diterima; limit=101 dan page=10001 ditolak", async () => {
        assert.equal((await list({ limit: "100" })).pagination.limit, 100);
        const far = await list({ page: "10000" });
        assert.deepEqual(far.transactions, []);
        assert.equal(far.pagination.page, 10000);
        await rejects400(list({ limit: "101" }), "limit");
        await rejects400(list({ page: "10001" }), "page");
    });

    test("page dan limit tidak valid ditolak", async () => {
        for (const value of ["0", "-1", "1.5", "1e2", "abc", " 2", "+2", "0x10", "01a", "1234567"]) {
            await rejects400(list({ page: value }), "page");
            await rejects400(list({ limit: value }), "limit");
        }
    });

    test("tie-breaker: transactionDate sama persis tetap berurutan stabil menurut id menurun, tanpa ganda", async () => {
        const seen = [];
        for (const page of ["1", "2", "3"]) {
            const r = await list({ limit: "2", page }, userTie);
            assert.equal(r.pagination.total, 6);
            seen.push(...ids(r));
        }
        assert.equal(seen.length, 6);
        assert.equal(new Set(seen).size, 6, "tidak boleh ada baris ganda");
        const sortedDesc = [...seen].sort((a, b) => (a < b ? 1 : -1));
        assert.deepEqual(seen, sortedDesc, "harus id menurun");
    });
});

// ---------- isolasi antar pengguna ----------

describe("isolasi data antar pengguna", () => {
    test("daftar user B hanya berisi milik B; milik A tidak pernah muncul", async () => {
        const r = await list({}, userB);
        assert.deepEqual(ids(r).sort(), [...bRowIds].sort());
        assert.equal(r.pagination.total, 2);
        for (const key of Object.keys(t)) assert.ok(!ids(r).includes(t[key]));
    });

    test("filter tidak membuka data user lain: dompet milik A dipakai oleh B -> kosong, dan sebaliknya", async () => {
        assert.deepEqual((await list({ walletId: String(wA1.id) }, userB)).transactions, []);
        assert.deepEqual((await list({ walletId: String(wB1.id) }, userA)).transactions, []);
    });

    test("kategori global dipakai kedua user tanpa saling membocorkan transaksi", async () => {
        const a = await list({ categoryId: String(incomeCat.id) }, userA);
        const b = await list({ categoryId: String(incomeCat.id) }, userB);
        assert.deepEqual(ids(a), [t.t6, t.t1]);
        assert.deepEqual(ids(b), [bRowIds[0]]);
    });

    test("total (count) juga dibatasi per user", async () => {
        assert.equal((await list({ type: "INCOME" }, userA)).pagination.total, 2);
        assert.equal((await list({ type: "INCOME" }, userB)).pagination.total, 1);
    });

    test("getTransaction: milik user lain dan id yang tidak ada memberi 404 yang sama", async () => {
        for (const [user, id] of [[userA, bRowIds[0]], [userB, t.t1], [userA, 999999999999n]]) {
            await assert.rejects(getTransaction(user.id, id), (err) => {
                assert.ok(err instanceof AppError);
                assert.equal(err.statusCode, 404);
                assert.equal(err.code, "TRANSACTION_NOT_FOUND");
                return true;
            });
        }
    });
});

// ---------- idempotencyKey tanpa awalan userId ----------

describe("idempotencyKey tidak membocorkan awalan userId", () => {
    let withKey;
    let legacy;

    before(async () => {
        withKey = await mk(userA, wA1, { type: "INCOME", status: "PENDING", source: "WEB", categoryId: incomeCat.id, idempotencyKey: `${userA.id}:kunci-uji-1`, transactionDate: D("2027-01-01T00:00:00Z") });
        legacy = await mk(userA, wA1, { type: "INCOME", status: "PENDING", source: "WEB", categoryId: incomeCat.id, idempotencyKey: `kunci-tanpa-awalan-${userA.id}`, transactionDate: D("2027-01-02T00:00:00Z") });
    });

    test("prasyarat: di database kunci memang tersimpan dengan awalan userId", async () => {
        const row = await prisma.transaction.findUnique({ where: { id: withKey } });
        assert.equal(row.idempotencyKey, `${userA.id}:kunci-uji-1`);
    });

    test("daftar dan detail mengembalikan kunci tanpa awalan", async () => {
        const r = await list({ from: "2027-01-01T00:00:00Z" });
        const byId = new Map(r.transactions.map((x) => [x.id, x]));
        assert.equal(byId.get(withKey).idempotencyKey, "kunci-uji-1");
        assert.equal(byId.get(legacy).idempotencyKey, `kunci-tanpa-awalan-${userA.id}`, "kunci tanpa awalan tidak diubah");

        assert.equal((await getTransaction(userA.id, withKey)).idempotencyKey, "kunci-uji-1");
        for (const x of r.transactions) {
            assert.ok(!String(x.idempotencyKey).startsWith(`${userA.id}:`));
        }
    });

    test("transaksi tanpa kunci mengembalikan null", async () => {
        assert.equal((await getTransaction(userA.id, t.t1)).idempotencyKey, null);
    });
});

// ---------- validasi query ----------

describe("validasi query string", () => {
    test("parameter tidak dikenal ditolak, termasuk userId", async () => {
        for (const query of [{ userId: String(userB.id) }, { sort: "asc" }, { foo: "bar" }, { "type[]": "INCOME" }, { "type[a]": "1" }, { __proto__x: "1" }]) {
            await rejects400(list(query));
        }
    });

    test("nilai ganda (array) dan string kosong ditolak", async () => {
        for (const name of ["type", "status", "source", "walletId", "categoryId", "from", "to", "page", "limit"]) {
            await rejects400(list({ [name]: ["a", "b"] }), name);
            await rejects400(list({ [name]: "" }), name);
            await rejects400(list({ [name]: "   " }), name);
        }
    });

    test("nilai enum harus persis huruf besar dan terdaftar", async () => {
        for (const [name, value] of [["type", "income"], ["type", "TRANSFERS"], ["type", "ALL"], ["status", "confirmed"], ["status", "DONE"], ["source", "web"], ["source", "SMS"]]) {
            await rejects400(list({ [name]: value }), name);
        }
    });

    test("walletId dan categoryId harus bilangan bulat positif yang valid", async () => {
        for (const value of ["abc", "0", "-1", "1.5", "1e3", "9223372036854775808", "99999999999999999999"]) {
            await rejects400(list({ walletId: value }), "walletId");
            await rejects400(list({ categoryId: value }), "categoryId");
        }
    });

    test("upaya injeksi SQL ditolak sebelum menyentuh database, dan tabel tetap utuh", async () => {
        const before = await prisma.transaction.count({ where: { userId: userA.id } });

        for (const query of [
            { type: "INCOME' OR '1'='1" },
            { status: "PENDING\" OR 1=1 --" },
            { walletId: "1 OR 1=1" },
            { walletId: "1; DROP TABLE transactions" },
            { categoryId: "1) OR (1=1" },
            { source: "WEB'; DELETE FROM transactions; --" },
            { from: "2026-01-01T00:00:00Z'; DROP TABLE transactions; --" },
        ]) {
            await rejects400(list(query));
        }

        assert.equal(await prisma.transaction.count({ where: { userId: userA.id } }), before);
    });
});

// ---------- detail ----------

describe("getTransaction", () => {
    test("ditemukan: baris lengkap milik user dengan tipe yang benar", async () => {
        const row = await getTransaction(userA.id, t.t4);
        assert.equal(row.id, t.t4);
        assert.equal(row.type, "TRANSFER");
        assert.equal(row.walletId, wA1.id);
        assert.equal(row.destinationWalletId, wA2.id);
        assert.equal(row.categoryId, null);
        assert.equal(row.status, "CONFIRMED");
    });

    test("id diterima sebagai string, number, atau BigInt", async () => {
        assert.equal((await getTransaction(userA.id, String(t.t1))).id, t.t1);
        assert.equal((await getTransaction(userA.id, t.t1)).id, t.t1);
        assert.equal((await getTransaction(userA.id, Number(t.t1))).id, t.t1);
    });

    test("id tidak valid ditolak 400", async () => {
        for (const bad of ["abc", "0", "-1", "1.5", "1e3", "", "income", "9223372036854775808"]) {
            await rejects400(getTransaction(userA.id, bad), "transactionId");
        }
    });

    test("query string apa pun pada detail ditolak 400", async () => {
        await rejects400(getTransaction(userA.id, t.t1, { userId: String(userB.id) }));
        await rejects400(getTransaction(userA.id, t.t1, { foo: "1" }));
        assert.equal((await getTransaction(userA.id, t.t1, {})).id, t.t1);
    });
});

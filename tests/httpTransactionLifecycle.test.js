// Pengujian Stage 2.3b: endpoint HTTP konfirmasi dan pembatalan transaksi.
//   POST /api/transactions/:id/confirm
//   POST /api/transactions/:id/cancel
// Jalankan dengan: npm test
// Server sungguhan (src/app.js) dijalankan di port 3221-3222. User, dompet, dan kategori
// SEMENTARA (nama diawali "__test_") dibuat lalu dihapus di akhir.
// Setiap tes memeriksa isi respons, status transaksi DI DATABASE, dan saldo (dibaca ulang dari
// database lewat getWalletBalances, lalu dicocokkan dengan saldo di respons).

import "dotenv/config";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import prisma from "../src/config/database.js";
import { getWalletBalances } from "../src/services/balanceService.js";
import { startServer, call } from "./helpers/httpServer.js";

const ALLOWED = "http://localhost:5173";
const FOREIGN = "http://evil.example";

let userA;
let userB;
let serverA; // DEFAULT_USER_ID = userA
let serverB; // DEFAULT_USER_ID = userB
let incomeCat;
let expenseCat;

before(async () => {
    userA = await prisma.user.create({ data: { name: "__test_life_a__" } });
    userB = await prisma.user.create({ data: { name: "__test_life_b__" } });
    incomeCat = await prisma.category.create({ data: { userId: null, name: "__test_life_income__", type: "INCOME" } });
    expenseCat = await prisma.category.create({ data: { userId: null, name: "__test_life_expense__", type: "EXPENSE" } });
    serverA = await startServer(3221, { DEFAULT_USER_ID: String(userA.id), CORS_ORIGINS: ALLOWED });
    serverB = await startServer(3222, { DEFAULT_USER_ID: String(userB.id), CORS_ORIGINS: ALLOWED });
});

after(async () => {
    serverA?.stop();
    serverB?.stop();
    const userIds = [userA.id, userB.id];
    await prisma.transaction.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.category.deleteMany({ where: { id: { in: [incomeCat.id, expenseCat.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
});

// ---------- helper ----------

const userOf = (server) => (server === serverA ? userA : userB);
const newWallet = (user, initialBalance = 1000, extra = {}) =>
    prisma.wallet.create({ data: { userId: user.id, name: "__test_wallet__", type: "CASH", initialBalance, ...extra } });

// Membuat transaksi PENDING lewat HTTP (endpoint 2.3a) dan mengembalikan id (string).
async function createTx(server, type, wallet, amount, extra = {}) {
    const body =
        type === "INCOME"
            ? { walletId: String(wallet.id), categoryId: String(incomeCat.id), amount, source: "WEB" }
            : type === "EXPENSE"
              ? { walletId: String(wallet.id), categoryId: String(expenseCat.id), amount, source: "WEB" }
              : { walletId: String(wallet.id), destinationWalletId: String(extra.to.id), amount, source: "WEB" };
    const res = await call(server.base, "POST", `/api/transactions/${type.toLowerCase()}`, { body });
    assert.equal(res.status, 201, res.text);
    return res.json.data.id;
}

// Memanggil confirm/cancel. Setiap respons (sukses maupun error) TIDAK boleh memuat key "userId"
// (pesan error 400 boleh menyebut nama field yang DIKIRIM klien, itu bukan kebocoran data).
async function act(server, action, id, options = {}) {
    const res = await call(server.base, "POST", `/api/transactions/${id}/${action}`, {
        body: options.body ?? {},
        headers: options.headers,
        json: options.json,
    });
    assert.ok(!/"userId"\s*:/.test(res.text), `respons memuat key userId: ${res.text}`);
    return res;
}
const confirm = (server, id, options) => act(server, "confirm", id, options);
const cancel = (server, id, options) => act(server, "cancel", id, options);

const dbStatus = async (id) => (await prisma.transaction.findUnique({ where: { id: BigInt(id) } })).status;
const dbBalance = async (wallet) =>
    (await getWalletBalances(prisma, wallet.userId, [wallet.id])).get(wallet.id).balance.toFixed(2);

function assertError(res, status, code) {
    assert.equal(res.status, status, `status ${res.status}: ${res.text}`);
    assert.equal(res.json?.success, false);
    assert.equal(res.json?.code, code);
}

// Memastikan respons sukses berbentuk { success, data: { transaction, balances } } dan
// saldo di respons sama dengan saldo yang dihitung ulang dari database.
async function assertSuccess(res, expectedStatus, wallets, expectedBalances) {
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.success, true);
    assert.deepEqual(Object.keys(res.json.data).sort(), ["balances", "transaction"]);
    assert.equal(res.json.data.transaction.status, expectedStatus);
    assert.equal(typeof res.json.data.transaction.id, "string");
    assert.equal(typeof res.json.data.transaction.amount, "string");

    const sorted = [...wallets].sort((a, b) => (a.id < b.id ? -1 : 1));
    assert.deepEqual(
        res.json.data.balances,
        sorted.map((w, i) => ({ walletId: String(w.id), balance: expectedBalances[i] })),
        "saldo di respons"
    );

    for (let i = 0; i < sorted.length; i++) {
        assert.equal(await dbBalance(sorted[i]), expectedBalances[i], "saldo yang dihitung ulang dari database");
    }
}

// ---------- CONFIRM ----------

describe("POST /:id/confirm (jalur sukses)", () => {
    test("INCOME: PENDING -> CONFIRMED, saldo bertambah", async () => {
        const w = await newWallet(userA, 1000);
        const id = await createTx(serverA, "INCOME", w, "500.00");
        assert.equal(await dbBalance(w), "1000.00", "PENDING belum memengaruhi saldo");

        const res = await confirm(serverA, id);
        await assertSuccess(res, "CONFIRMED", [w], ["1500.00"]);
        assert.equal(res.json.data.transaction.id, id);
        assert.equal(await dbStatus(id), "CONFIRMED");
    });

    test("EXPENSE: PENDING -> CONFIRMED, saldo berkurang", async () => {
        const w = await newWallet(userA, 1000);
        const id = await createTx(serverA, "EXPENSE", w, "400.50");

        await assertSuccess(await confirm(serverA, id), "CONFIRMED", [w], ["599.50"]);
        assert.equal(await dbStatus(id), "CONFIRMED");
    });

    test("TRANSFER: saldo sumber berkurang dan tujuan bertambah, keduanya ada di balances (urut id)", async () => {
        const from = await newWallet(userA, 1000);
        const to = await newWallet(userA, 200);
        const id = await createTx(serverA, "TRANSFER", from, "300.00", { to });

        await assertSuccess(await confirm(serverA, id), "CONFIRMED", [from, to], ["700.00", "500.00"]);
        assert.equal(await dbStatus(id), "CONFIRMED");
    });
});

describe("POST /:id/confirm (penolakan)", () => {
    test("404 TRANSACTION_NOT_FOUND untuk id yang tidak ada", async () => {
        assertError(await confirm(serverA, "999999999999"), 404, "TRANSACTION_NOT_FOUND");
    });

    test("404 untuk transaksi milik user lain, dan transaksi itu tidak berubah", async () => {
        const wb = await newWallet(userB, 1000);
        const id = await createTx(serverB, "INCOME", wb, "100.00");

        assertError(await confirm(serverA, id), 404, "TRANSACTION_NOT_FOUND");
        assert.equal(await dbStatus(id), "PENDING");
        assert.equal(await dbBalance(wb), "1000.00");
    });

    test("400 VALIDATION_ERROR untuk id tidak valid", async () => {
        for (const id of ["abc", "0", "-1", "1.5", "1e3", "%20", "99999999999999999999", "9223372036854775808", "income"]) {
            assertError(await confirm(serverA, id), 400, "VALIDATION_ERROR");
        }
    });

    test("422 INSUFFICIENT_BALANCE: saldo kurang, transaksi tetap PENDING", async () => {
        const w = await newWallet(userA, 100);
        const id = await createTx(serverA, "EXPENSE", w, "500.00");

        const res = await confirm(serverA, id);
        assertError(res, 422, "INSUFFICIENT_BALANCE");
        assert.equal(res.json.details.available, "100.00");
        assert.equal(res.json.details.required, "500.00");
        assert.equal(await dbStatus(id), "PENDING");
        assert.equal(await dbBalance(w), "100.00");
    });

    test("422 INSUFFICIENT_BALANCE juga untuk TRANSFER", async () => {
        const from = await newWallet(userA, 100);
        const to = await newWallet(userA, 0);
        const id = await createTx(serverA, "TRANSFER", from, "100.01", { to });

        assertError(await confirm(serverA, id), 422, "INSUFFICIENT_BALANCE");
        assert.equal(await dbStatus(id), "PENDING");
        assert.equal(await dbBalance(to), "0.00");
    });

    test("409 TRANSACTION_NOT_PENDING bila sudah CONFIRMED, dan saldo tidak dihitung dua kali", async () => {
        const w = await newWallet(userA, 1000);
        const id = await createTx(serverA, "INCOME", w, "500.00");
        assert.equal((await confirm(serverA, id)).status, 200);

        const again = await confirm(serverA, id);
        assertError(again, 409, "TRANSACTION_NOT_PENDING");
        assert.equal(await dbBalance(w), "1500.00");
    });

    test("409 TRANSACTION_NOT_PENDING bila sudah CANCELLED (final)", async () => {
        const w = await newWallet(userA, 1000);
        const id = await createTx(serverA, "INCOME", w, "500.00");
        assert.equal((await cancel(serverA, id)).status, 200);

        assertError(await confirm(serverA, id), 409, "TRANSACTION_NOT_PENDING");
        assert.equal(await dbStatus(id), "CANCELLED");
        assert.equal(await dbBalance(w), "1000.00");
    });

    test("kebijakan dompet nonaktif dari service tetap berlaku: 422 WALLET_INACTIVE, tetap PENDING", async () => {
        const w = await newWallet(userA, 1000);
        const id = await createTx(serverA, "INCOME", w, "50.00");
        await prisma.wallet.update({ where: { id: w.id }, data: { isActive: false } });

        assertError(await confirm(serverA, id), 422, "WALLET_INACTIVE");
        assert.equal(await dbStatus(id), "PENDING");
    });
});

describe("POST /:id/confirm (identitas pengguna)", () => {
    test("userId di query dan header X-User-Id tidak mengubah pemilik operasi", async () => {
        // Server A mencoba memakai identitas B lewat query dan header: tetap 404 untuk transaksi B.
        const wb = await newWallet(userB, 1000);
        const idB = await createTx(serverB, "INCOME", wb, "100.00");
        const res = await call(serverA.base, "POST", `/api/transactions/${idB}/confirm?userId=${userB.id}`, {
            body: {},
            headers: { "X-User-Id": String(userB.id) },
        });
        assertError(res, 404, "TRANSACTION_NOT_FOUND");
        assert.equal(await dbStatus(idB), "PENDING");

        // Transaksi milik A tetap bisa dikonfirmasi walau query/header menunjuk B.
        const wa = await newWallet(userA, 1000);
        const idA = await createTx(serverA, "INCOME", wa, "100.00");
        const ok = await call(serverA.base, "POST", `/api/transactions/${idA}/confirm?userId=${userB.id}`, {
            body: {},
            headers: { "X-User-Id": String(userB.id) },
        });
        assert.equal(ok.status, 200, ok.text);
        assert.equal(await dbStatus(idA), "CONFIRMED");
    });

    test("userId di body ditolak 400 dan transaksi tidak berubah", async () => {
        const w = await newWallet(userA, 1000);
        const id = await createTx(serverA, "INCOME", w, "100.00");
        assertError(await confirm(serverA, id, { body: { userId: String(userB.id) } }), 400, "VALIDATION_ERROR");
        assert.equal(await dbStatus(id), "PENDING");
    });
});

// ---------- CANCEL ----------

describe("POST /:id/cancel (jalur sukses)", () => {
    test("PENDING -> CANCELLED tanpa mengubah saldo, cancelledAt terisi", async () => {
        const w = await newWallet(userA, 1000);
        const id = await createTx(serverA, "EXPENSE", w, "300.00");

        const res = await cancel(serverA, id);
        await assertSuccess(res, "CANCELLED", [w], ["1000.00"]);
        assert.ok(res.json.data.transaction.cancelledAt, "cancelledAt harus terisi");
        assert.equal(await dbStatus(id), "CANCELLED");
    });

    test("CONFIRMED INCOME dibatalkan: saldo kembali bila tidak menjadi minus", async () => {
        const w = await newWallet(userA, 1000);
        const id = await createTx(serverA, "INCOME", w, "500.00");
        await confirm(serverA, id);
        assert.equal(await dbBalance(w), "1500.00");

        await assertSuccess(await cancel(serverA, id), "CANCELLED", [w], ["1000.00"]);
        assert.equal(await dbStatus(id), "CANCELLED");
    });

    test("CONFIRMED EXPENSE dibatalkan: saldo dikembalikan", async () => {
        const w = await newWallet(userA, 1000);
        const id = await createTx(serverA, "EXPENSE", w, "400.00");
        await confirm(serverA, id);
        assert.equal(await dbBalance(w), "600.00");

        await assertSuccess(await cancel(serverA, id), "CANCELLED", [w], ["1000.00"]);
    });

    test("CONFIRMED TRANSFER dibatalkan: sumber bertambah, tujuan berkurang", async () => {
        const from = await newWallet(userA, 1000);
        const to = await newWallet(userA, 200);
        const id = await createTx(serverA, "TRANSFER", from, "300.00", { to });
        await confirm(serverA, id);
        assert.equal(await dbBalance(from), "700.00");
        assert.equal(await dbBalance(to), "500.00");

        await assertSuccess(await cancel(serverA, id), "CANCELLED", [from, to], ["1000.00", "200.00"]);
    });
});

describe("POST /:id/cancel (penolakan)", () => {
    test("422 CANCELLATION_NEGATIVE_BALANCE: membatalkan INCOME yang dananya sudah terpakai", async () => {
        const w = await newWallet(userA, 0);
        const income = await createTx(serverA, "INCOME", w, "500.00");
        const expense = await createTx(serverA, "EXPENSE", w, "300.00");
        await confirm(serverA, income);
        await confirm(serverA, expense);
        assert.equal(await dbBalance(w), "200.00");

        const res = await cancel(serverA, income);
        assertError(res, 422, "CANCELLATION_NEGATIVE_BALANCE");
        assert.equal(res.json.details.balanceAfterCancellation, "-300.00");
        assert.equal(await dbStatus(income), "CONFIRMED");
        assert.equal(await dbBalance(w), "200.00");
    });

    test("422 CANCELLATION_NEGATIVE_BALANCE: membatalkan TRANSFER yang dana tujuannya sudah terpakai", async () => {
        const from = await newWallet(userA, 1000);
        const to = await newWallet(userA, 0);
        const transfer = await createTx(serverA, "TRANSFER", from, "500.00", { to });
        const spend = await createTx(serverA, "EXPENSE", to, "400.00");
        await confirm(serverA, transfer);
        await confirm(serverA, spend);

        assertError(await cancel(serverA, transfer), 422, "CANCELLATION_NEGATIVE_BALANCE");
        assert.equal(await dbStatus(transfer), "CONFIRMED");
        assert.equal(await dbBalance(from), "500.00");
        assert.equal(await dbBalance(to), "100.00");
    });

    test("404 untuk id yang tidak ada dan untuk transaksi milik user lain (tidak berubah)", async () => {
        assertError(await cancel(serverA, "999999999999"), 404, "TRANSACTION_NOT_FOUND");

        const wb = await newWallet(userB, 1000);
        const id = await createTx(serverB, "INCOME", wb, "100.00");
        assertError(await cancel(serverA, id), 404, "TRANSACTION_NOT_FOUND");
        assert.equal(await dbStatus(id), "PENDING");
    });

    test("400 VALIDATION_ERROR untuk id tidak valid", async () => {
        for (const id of ["abc", "0", "-1", "1.5", "1e3", "%20", "99999999999999999999", "9223372036854775808", "expense"]) {
            assertError(await cancel(serverA, id), 400, "VALIDATION_ERROR");
        }
    });

    test("409 TRANSACTION_ALREADY_CANCELLED bila dibatalkan lagi, tanpa mengubah apa pun", async () => {
        const w = await newWallet(userA, 1000);
        const id = await createTx(serverA, "INCOME", w, "500.00");
        assert.equal((await cancel(serverA, id)).status, 200);

        assertError(await cancel(serverA, id), 409, "TRANSACTION_ALREADY_CANCELLED");
        assert.equal(await dbStatus(id), "CANCELLED");
        assert.equal(await dbBalance(w), "1000.00");
    });

    test("kebijakan dompet nonaktif dari service tetap berlaku: 422 WALLET_INACTIVE, status tidak berubah", async () => {
        const w = await newWallet(userA, 1000);
        const id = await createTx(serverA, "INCOME", w, "50.00");
        await prisma.wallet.update({ where: { id: w.id }, data: { isActive: false } });

        assertError(await cancel(serverA, id), 422, "WALLET_INACTIVE");
        assert.equal(await dbStatus(id), "PENDING");
    });

    test("userId di body ditolak 400; query/header userId tidak memberi akses ke transaksi user lain", async () => {
        const wa = await newWallet(userA, 1000);
        const idA = await createTx(serverA, "INCOME", wa, "10.00");
        assertError(await cancel(serverA, idA, { body: { userId: String(userB.id) } }), 400, "VALIDATION_ERROR");
        assert.equal(await dbStatus(idA), "PENDING");

        const wb = await newWallet(userB, 1000);
        const idB = await createTx(serverB, "INCOME", wb, "10.00");
        const res = await call(serverA.base, "POST", `/api/transactions/${idB}/cancel?userId=${userB.id}`, {
            body: {},
            headers: { "X-User-Id": String(userB.id) },
        });
        assertError(res, 404, "TRANSACTION_NOT_FOUND");
        assert.equal(await dbStatus(idB), "PENDING");
    });
});

// ---------- kontrak body, JSON guard, CORS ----------

describe("kontrak body dan keamanan pada confirm/cancel", () => {
    for (const action of ["confirm", "cancel"]) {
        const send = (id, options) => act(serverA, action, id, options);
        const fresh = async () => createTx(serverA, "INCOME", await newWallet(userA, 1000), "10.00");

        test(`${action}: tanpa isi dan {} diterima dan diperlakukan sama`, async () => {
            const id1 = await fresh();
            const empty = await call(serverA.base, "POST", `/api/transactions/${id1}/${action}`, {
                headers: { "Content-Type": "application/json" },
            });
            assert.equal(empty.status, 200, empty.text);

            const id2 = await fresh();
            const obj = await send(id2, { body: {} });
            assert.equal(obj.status, 200, obj.text);
            assert.deepEqual(Object.keys(empty.json.data), Object.keys(obj.json.data));
            assert.equal(empty.json.data.transaction.status, obj.json.data.transaction.status);
        });

        test(`${action}: objek berisi field apa pun (userId, status, dll) -> 400 VALIDATION_ERROR, tidak ada perubahan`, async () => {
            for (const body of [{ userId: String(userB.id) }, { status: "CONFIRMED" }, { amount: "1.00" }, { a: null }]) {
                const id = await fresh();
                assertError(await send(id, { body }), 400, "VALIDATION_ERROR");
                assert.equal(await dbStatus(id), "PENDING");
            }
        });

        test(`${action}: array -> 400 VALIDATION_ERROR`, async () => {
            const id = await fresh();
            for (const body of ["[]", "[1]", '[{"userId":"1"}]']) {
                assertError(await send(id, { body }), 400, "VALIDATION_ERROR");
            }
            assert.equal(await dbStatus(id), "PENDING");
        });

        test(`${action}: null, string, angka, boolean, dan JSON rusak -> 400 INVALID_JSON`, async () => {
            const id = await fresh();
            for (const body of ["null", '"abc"', "5", "true", "{ rusak"]) {
                assertError(await send(id, { body }), 400, "INVALID_JSON");
            }
            assert.equal(await dbStatus(id), "PENDING");
        });

        test(`${action}: Content-Type bukan JSON -> 415 dan tidak ada perubahan`, async () => {
            const id = await fresh();
            const url = `${serverA.base}/api/transactions/${id}/${action}`;
            const attempts = [
                fetch(url, { method: "POST" }),
                fetch(url, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" }),
                fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "a=1" }),
            ];
            for (const response of await Promise.all(attempts)) {
                assert.equal(response.status, 415);
                assert.equal((await response.json()).code, "UNSUPPORTED_MEDIA_TYPE");
            }
            assert.equal(await dbStatus(id), "PENDING");
        });

        test(`${action}: CORS allowlist tetap berlaku (origin asing tidak mendapat header CORS)`, async () => {
            const preflight = (origin) =>
                call(serverA.base, "OPTIONS", `/api/transactions/1/${action}`, {
                    headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
                });
            assert.equal((await preflight(ALLOWED)).headers.get("access-control-allow-origin"), ALLOWED);
            assert.equal((await preflight(FOREIGN)).headers.get("access-control-allow-origin"), null);
        });
    }

    test("GET pada route confirm/cancel dan daftar/detail transaksi tetap 404 (baru ada di 2.3c)", async () => {
        for (const path of ["/api/transactions/1/confirm", "/api/transactions/1/cancel", "/api/transactions", "/api/transactions/1"]) {
            assertError(await call(serverA.base, "GET", path), 404, "ROUTE_NOT_FOUND");
        }
    });
});

// ---------- konkurensi lewat HTTP ----------
// Setiap tes memeriksa status akhir DI DATABASE dan saldo hasil hitung ulang, bukan hanya kode HTTP.

describe("konkurensi confirm dan cancel", () => {
    test("8 confirm bersamaan pada satu transaksi: tepat satu 200, tujuh 409, saldo hanya bertambah sekali", async () => {
        const w = await newWallet(userA, 1000);
        const id = await createTx(serverA, "INCOME", w, "500.00");

        const results = await Promise.all(Array.from({ length: 8 }, () => confirm(serverA, id)));

        assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409, 409, 409, 409, 409, 409]);
        for (const r of results.filter((x) => x.status === 409)) assert.equal(r.json.code, "TRANSACTION_NOT_PENDING");
        assert.equal(await dbStatus(id), "CONFIRMED");
        assert.equal(await dbBalance(w), "1500.00", "nominal tidak boleh dihitung lebih dari sekali");
    });

    test("8 cancel bersamaan pada satu transaksi: tepat satu 200, tujuh 409 ALREADY_CANCELLED", async () => {
        const w = await newWallet(userA, 1000);
        const id = await createTx(serverA, "EXPENSE", w, "200.00");
        await confirm(serverA, id);

        const results = await Promise.all(Array.from({ length: 8 }, () => cancel(serverA, id)));

        assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409, 409, 409, 409, 409, 409]);
        for (const r of results.filter((x) => x.status === 409)) assert.equal(r.json.code, "TRANSACTION_ALREADY_CANCELLED");
        assert.equal(await dbStatus(id), "CANCELLED");
        assert.equal(await dbBalance(w), "1000.00");
    });

    test("dua EXPENSE (700 dan 600) pada saldo 1000 dikonfirmasi bersamaan: hanya satu yang berhasil", async () => {
        for (let round = 0; round < 3; round++) {
            const w = await newWallet(userA, 1000);
            const e700 = await createTx(serverA, "EXPENSE", w, "700.00");
            const e600 = await createTx(serverA, "EXPENSE", w, "600.00");

            const [r700, r600] = await Promise.all([confirm(serverA, e700), confirm(serverA, e600)]);

            assert.deepEqual([r700.status, r600.status].sort(), [200, 422], `${r700.text} | ${r600.text}`);
            const winner = r700.status === 200 ? { id: e700, loserId: e600, amount: 700, loser: r600 } : { id: e600, loserId: e700, amount: 600, loser: r700 };
            assert.equal(winner.loser.json.code, "INSUFFICIENT_BALANCE");
            assert.equal(await dbStatus(winner.id), "CONFIRMED");
            assert.equal(await dbStatus(winner.loserId), "PENDING", "yang gagal tetap PENDING");
            assert.equal(await dbBalance(w), (1000 - winner.amount).toFixed(2));
        }
    });

    test("tiga EXPENSE 400 pada saldo 1000 dikonfirmasi bersamaan: tepat dua berhasil, satu 422, saldo akhir 200", async () => {
        const w = await newWallet(userA, 1000);
        const ids = [];
        for (let i = 0; i < 3; i++) ids.push(await createTx(serverA, "EXPENSE", w, "400.00"));

        const results = await Promise.all(ids.map((id) => confirm(serverA, id)));

        assert.deepEqual(results.map((r) => r.status).sort(), [200, 200, 422]);
        const statuses = await Promise.all(ids.map(dbStatus));
        assert.equal(statuses.filter((s) => s === "CONFIRMED").length, 2);
        assert.equal(statuses.filter((s) => s === "PENDING").length, 1);
        // Transaksi yang berhasil di HTTP harus tepat yang CONFIRMED di database.
        results.forEach((r, i) => assert.equal(r.status === 200, statuses[i] === "CONFIRMED"));
        assert.equal(await dbBalance(w), "200.00");
    });

    test("confirm dan cancel bersamaan pada transaksi PENDING yang sama: status akhir konsisten dan saldo benar", async () => {
        for (let round = 0; round < 5; round++) {
            const w = await newWallet(userA, 1000);
            const id = await createTx(serverA, "INCOME", w, "500.00");

            const [c, x] = await Promise.all([confirm(serverA, id), cancel(serverA, id)]);

            // Urutan A: confirm lalu cancel -> [200, 200]. Urutan B: cancel dulu -> confirm 409.
            assert.equal(x.status, 200, `cancel harus berhasil: ${x.text}`);
            assert.ok(c.status === 200 || c.status === 409, `confirm: ${c.status} ${c.text}`);
            assert.equal(await dbStatus(id), "CANCELLED", "CANCELLED bersifat final");
            assert.equal(await dbBalance(w), "1000.00", "transaksi CANCELLED tidak boleh memengaruhi saldo");
        }
    });

    test("cancel INCOME dan confirm EXPENSE bersamaan: saldo tidak pernah minus dan tepat satu yang berhasil", async () => {
        for (let round = 0; round < 3; round++) {
            const w = await newWallet(userA, 0);
            const income = await createTx(serverA, "INCOME", w, "500.00");
            await confirm(serverA, income); // saldo 500
            const expense = await createTx(serverA, "EXPENSE", w, "400.00");

            const [cx, ce] = await Promise.all([cancel(serverA, income), confirm(serverA, expense)]);

            assert.deepEqual([cx.status, ce.status].sort(), [200, 422], `${cx.text} | ${ce.text}`);

            if (cx.status === 200) {
                // cancel menang: INCOME dibatalkan, EXPENSE ditolak karena saldo 0
                assert.equal(ce.json.code, "INSUFFICIENT_BALANCE");
                assert.equal(await dbStatus(income), "CANCELLED");
                assert.equal(await dbStatus(expense), "PENDING");
                assert.equal(await dbBalance(w), "0.00");
            } else {
                // confirm menang: EXPENSE dikonfirmasi, pembatalan INCOME ditolak karena akan minus
                assert.equal(cx.json.code, "CANCELLATION_NEGATIVE_BALANCE");
                assert.equal(await dbStatus(income), "CONFIRMED");
                assert.equal(await dbStatus(expense), "CONFIRMED");
                assert.equal(await dbBalance(w), "100.00");
            }
        }
    });

    test("transfer A->B dan B->A dikonfirmasi bersamaan tidak deadlock dan saldo konsisten", async () => {
        const a = await newWallet(userA, 1000);
        const b = await newWallet(userA, 1000);
        const ab = await createTx(serverA, "TRANSFER", a, "100.00", { to: b });
        const ba = await createTx(serverA, "TRANSFER", b, "250.00", { to: a });

        const [r1, r2] = await Promise.all([confirm(serverA, ab), confirm(serverA, ba)]);

        assert.equal(r1.status, 200, r1.text);
        assert.equal(r2.status, 200, r2.text);
        assert.equal(await dbBalance(a), "1150.00");
        assert.equal(await dbBalance(b), "850.00");
    });
});

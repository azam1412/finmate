import { createIncome, createExpense, createTransfer } from "../services/transactionService.js";
import { confirmTransaction } from "../services/confirmationService.js";
import { cancelTransaction } from "../services/cancellationService.js";
import { listTransactions, getTransaction } from "../services/transactionQueryService.js";
import {
    presentTransactionForClient,
    presentResultForClient,
    presentTransactionListForClient,
} from "./transactionPresenter.js";

// Controller TIPIS: hanya menghubungkan HTTP dengan service. Semua validasi dan aturan bisnis
// (kepemilikan, status, saldo, penguncian) ada di service. userId HANYA dari req.user.id
// (userContext), tidak pernah dari body, query, params, atau header.

// Pembuatan (Stage 2.3a). Respons: 201 jika transaksi baru dibuat; 200 jika permintaan ulang
// dengan idempotencyKey dan isi yang sama (mengembalikan transaksi yang sudah ada, created: false).
function createHandler(service) {
    return async (req, res) => {
        const { transaction, created } = await service(req.user.id, req.body);

        res.status(created ? 201 : 200).json({
            success: true,
            created,
            data: presentTransactionForClient(transaction),
        });
    };
}

export const postIncome = createHandler(createIncome);
export const postExpense = createHandler(createExpense);
export const postTransfer = createHandler(createTransfer);

// Konfirmasi dan pembatalan (Stage 2.3b). Respons 200: { success, data: { transaction, balances } }.
//
// CATATAN IDEMPOTENSI: endpoint ini TIDAK memakai Idempotency-Key. Jika permintaan berhasil tetapi
// responsnya hilang di jaringan, mengulang permintaan menghasilkan 409 (TRANSACTION_NOT_PENDING
// atau TRANSACTION_ALREADY_CANCELLED) padahal operasi pertama sudah berhasil. Pemulihan lewat
// pembacaan detail transaksi baru tersedia setelah Stage 2.3c.
function actionHandler(service) {
    return async (req, res) => {
        const result = await service(req.user.id, req.params.id);

        res.status(200).json({ success: true, data: presentResultForClient(result) });
    };
}

export const postConfirm = actionHandler(confirmTransaction);
export const postCancel = actionHandler(cancelTransaction);

// Membaca transaksi (Stage 2.3c). Query string divalidasi di service; userId hanya dari req.user.id.
// Daftar: { success, data: [transaksi], pagination }. Detail: { success, data: transaksi }.
export async function getList(req, res) {
    const { transactions, pagination } = await listTransactions(req.user.id, req.query);

    res.status(200).json({
        success: true,
        data: presentTransactionListForClient(transactions),
        pagination,
    });
}

export async function getDetail(req, res) {
    const transaction = await getTransaction(req.user.id, req.params.id, req.query);

    res.status(200).json({ success: true, data: presentTransactionForClient(transaction) });
}

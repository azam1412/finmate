import { createIncome, createExpense, createTransfer } from "../services/transactionService.js";
import { presentTransactionForClient } from "./transactionPresenter.js";

// Controller TIPIS: hanya menghubungkan HTTP dengan service. Semua validasi dan aturan bisnis
// ada di services/transactionService.js. userId HANYA dari req.user.id (userContext),
// tidak pernah dari body, query, atau header.
//
// Respons: 201 jika transaksi baru dibuat; 200 jika permintaan ulang dengan idempotencyKey
// dan isi yang sama (mengembalikan transaksi yang sudah ada, created: false).

function handler(service) {
    return async (req, res) => {
        const { transaction, created } = await service(req.user.id, req.body);

        res.status(created ? 201 : 200).json({
            success: true,
            created,
            data: presentTransactionForClient(transaction),
        });
    };
}

export const postIncome = handler(createIncome);
export const postExpense = handler(createExpense);
export const postTransfer = handler(createTransfer);

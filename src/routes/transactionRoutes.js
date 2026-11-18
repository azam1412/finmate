import { Router } from "express";
import requireEmptyBody from "../middleware/requireEmptyBody.js";
import {
    postIncome,
    postExpense,
    postTransfer,
    postConfirm,
    postCancel,
} from "../controllers/transactionController.js";

// Stage 2.3a: pembuatan transaksi (selalu berstatus PENDING).
// Stage 2.3b: konfirmasi dan pembatalan (body harus kosong atau {}).
// Daftar/detail (2.3c) ditambahkan di tahap berikutnya.
const router = Router();

router.post("/income", postIncome);
router.post("/expense", postExpense);
router.post("/transfer", postTransfer);

router.post("/:id/confirm", requireEmptyBody, postConfirm);
router.post("/:id/cancel", requireEmptyBody, postCancel);

export default router;

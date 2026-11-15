import { Router } from "express";
import { postIncome, postExpense, postTransfer } from "../controllers/transactionController.js";

// Stage 2.3a: hanya pembuatan transaksi (selalu berstatus PENDING).
// Konfirmasi/pembatalan (2.3b) dan daftar/detail (2.3c) ditambahkan di tahap berikutnya.
const router = Router();

router.post("/income", postIncome);
router.post("/expense", postExpense);
router.post("/transfer", postTransfer);

export default router;

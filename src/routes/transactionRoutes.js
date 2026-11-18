import { Router } from "express";
import requireEmptyBody from "../middleware/requireEmptyBody.js";
import {
    postIncome,
    postExpense,
    postTransfer,
    postConfirm,
    postCancel,
    getList,
    getDetail,
} from "../controllers/transactionController.js";

// Stage 2.3a: pembuatan transaksi (selalu berstatus PENDING).
// Stage 2.3b: konfirmasi dan pembatalan (body harus kosong atau {}).
// Stage 2.3c: daftar dan detail (hanya membaca; query string divalidasi ketat).
const router = Router();

router.post("/income", postIncome);
router.post("/expense", postExpense);
router.post("/transfer", postTransfer);

router.post("/:id/confirm", requireEmptyBody, postConfirm);
router.post("/:id/cancel", requireEmptyBody, postCancel);

router.get("/", getList);
router.get("/:id", getDetail);

export default router;

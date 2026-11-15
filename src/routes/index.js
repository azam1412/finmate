import { Router } from "express";
import requireJson from "../middleware/requireJson.js";
import userContext from "../middleware/userContext.js";
import transactionRoutes from "./transactionRoutes.js";

// Semua route di bawah /api memerlukan pengguna (req.user) yang valid.
// Modul berikutnya (wallets, categories, transactions) didaftarkan di sini.
const router = Router();

router.use(requireJson);
router.use(userContext);

// Pemeriksaan: siapa pengguna yang sedang aktif? Juga membuktikan id BigInt terkirim sebagai string.
router.get("/me", (req, res) => {
    res.json({
        success: true,
        data: {
            id: req.user.id,
            name: req.user.name,
        },
    });
});

router.use("/transactions", transactionRoutes);

export default router;

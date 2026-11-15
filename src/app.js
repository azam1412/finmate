import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { buildCorsOptions } from "./config/cors.js";
import prisma from "./config/database.js";

import apiRouter from "./routes/index.js";
import {
    notFoundHandler,
    errorHandler,
} from "./middleware/errorHandler.js";

import { jsonReplacer } from "./utils/serialize.js";

const app = express();

// Serialisasi BigInt dan Decimal untuk seluruh respons JSON
app.set("json replacer", jsonReplacer);

const PORT = process.env.PORT || 3000;

// Selama belum ada autentikasi, server hanya mendengarkan di komputer ini (loopback).
// Ubah BIND_HOST hanya bila Anda benar-benar mengerti risikonya.
const HOST = process.env.BIND_HOST || "127.0.0.1";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

// Middleware
app.use(cors(buildCorsOptions(process.env)));
app.use(helmet());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// halaman utama
app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "Welcome to the API",
    });
});

// health check endpoint
app.get("/health", async (req, res) => {
    try {
        await prisma.$queryRaw`SELECT 1`;

        res.status(200).json({ 
            success: true, 
            message: "Database connection is healthy", 
            database: "connected", 
            timestamp: new Date().toISOString() });
    } catch (error) {
        console.error("Health check failed:", error);

        res.status(500).json({ 
            success: false, 
            message: "Error occurred while checking health", 
            database: "disconnected", 
            error: error.message, 
            timestamp: new Date().toISOString() 
        });
    }
});

// API router
app.use("/api", apiRouter);

// notFoundHandler harus dipasang setelah semua route
app.use(notFoundHandler);

//global error handler harus dipasang paling akhir
app.use(errorHandler);

//export app untuk digunakan di server.js
export default app;

//menjalankan server
app.listen(PORT, HOST, () => {
    console.log(`Server is running on http://${HOST}:${PORT}`);

    if (!LOOPBACK_HOSTS.has(HOST)) {
        console.warn(
            `PERINGATAN: server dapat diakses dari luar komputer ini (BIND_HOST=${HOST}), ` +
                "padahal autentikasi belum tersedia. Jangan ekspos API ini ke jaringan publik."
        );
    }
});
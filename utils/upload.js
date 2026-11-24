const multer = require("multer");

// NOTE: HEIC/HEIF removed: sharp's prebuilt binaries can't decode them, so
// accepting them only produced a 500 later. Clients should send JPEG/PNG/WebP.
module.exports = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 }, // 5MB
  fileFilter: (req, file, cb) => {
    const ok = ["image/jpeg", "image/png", "image/webp"].includes(file.mimetype);
    cb(ok ? null : new Error("Unsupported file type"), ok);
  },
});

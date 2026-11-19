require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");

const app = express();
app.use(express.json());

/* ---------- Schema ---------- */
const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, "Name is required"], trim: true, minlength: 2 },
    sku: { type: String, required: [true, "SKU is required"], unique: true, uppercase: true, trim: true },
    category: { type: String, required: [true, "Category is required"], trim: true },
    price: { type: Number, required: [true, "Price is required"], min: [0, "Price cannot be negative"] },
    quantity: { type: Number, required: true, min: [0, "Quantity cannot be negative"], default: 0 },
    reorderLevel: { type: Number, min: 0, default: 10 },
    supplier: { type: String, trim: true },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);
productSchema.virtual("stockValue").get(function () {
  return this.price * this.quantity;
});
const Product = mongoose.model("Product", productSchema);

/* ---------- Middleware ---------- */
const validateId = (req, res, next) => {
  if (!mongoose.isValidObjectId(req.params.id))
    return res.status(400).json({ error: "Invalid product ID" });
  next();
};
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ---------- Routes ---------- */
const router = express.Router();

// Create
router.post("/", wrap(async (req, res) => {
  const product = await Product.create(req.body);
  res.status(201).json(product);
}));

// List: filter, sort, paginate
router.get("/", wrap(async (req, res) => {
  const { category, supplier, search, minPrice, maxPrice, sort = "-createdAt" } = req.query;
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.max(parseInt(req.query.limit) || 10, 1);

  const filter = {};
  if (category) filter.category = new RegExp(`^${category}$`, "i");
  if (supplier) filter.supplier = new RegExp(supplier, "i");
  if (search) filter.name = new RegExp(search, "i");
  if (minPrice || maxPrice) {
    filter.price = {};
    if (minPrice) filter.price.$gte = Number(minPrice);
    if (maxPrice) filter.price.$lte = Number(maxPrice);
  }

  const total = await Product.countDocuments(filter);
  const products = await Product.find(filter)
    .sort(sort.split(",").join(" "))
    .skip((page - 1) * limit)
    .limit(limit);

  res.json({ total, page, totalPages: Math.ceil(total / limit), count: products.length, products });
}));

// Low-stock report (must be before /:id)
router.get("/low-stock", wrap(async (req, res) => {
  const lowStockItems = await Product.find({ $expr: { $lte: ["$quantity", "$reorderLevel"] } }).sort("quantity");
  res.json({ count: lowStockItems.length, lowStockItems });
}));

// Category summary (aggregation)
router.get("/summary", wrap(async (req, res) => {
  const summary = await Product.aggregate([
    {
      $group: {
        _id: "$category",
        totalItems: { $sum: 1 },
        totalQuantity: { $sum: "$quantity" },
        totalStockValue: { $sum: { $multiply: ["$price", "$quantity"] } },
        avgPrice: { $avg: "$price" },
      },
    },
    { $sort: { totalStockValue: -1 } },
  ]);
  res.json({ categories: summary.length, summary });
}));

// Get one
router.get("/:id", validateId, wrap(async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) return res.status(404).json({ error: "Product not found" });
  res.json(product);
}));

// Update details
router.put("/:id", validateId, wrap(async (req, res) => {
  const product = await Product.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
    runValidators: true,
  });
  if (!product) return res.status(404).json({ error: "Product not found" });
  res.json(product);
}));

// Stock adjustment, body: { "change": 10 } or -5
router.patch("/:id/stock", validateId, wrap(async (req, res) => {
  const change = Number(req.body.change);
  if (!Number.isFinite(change) || change === 0)
    return res.status(400).json({ error: "'change' must be a non-zero number" });

  const product = await Product.findOneAndUpdate(
    { _id: req.params.id, quantity: { $gte: change < 0 ? -change : 0 } },
    { $inc: { quantity: change } },
    { new: true }
  );
  if (!product) {
    const exists = await Product.exists({ _id: req.params.id });
    return res.status(exists ? 400 : 404).json({
      error: exists ? "Insufficient stock" : "Product not found",
    });
  }
  res.json({ message: "Stock updated", product });
}));

// Delete
router.delete("/:id", validateId, wrap(async (req, res) => {
  const product = await Product.findByIdAndDelete(req.params.id);
  if (!product) return res.status(404).json({ error: "Product not found" });
  res.json({ message: "Product deleted", id: product.id });
}));

app.use("/api/products", router);

/* ---------- Centralized error handler ---------- */
app.use((req, res) => res.status(404).json({ error: "Route not found" }));
app.use((err, req, res, next) => {
  if (err.name === "ValidationError")
    return res.status(400).json({ error: Object.values(err.errors).map((e) => e.message) });
  if (err.code === 11000)
    return res.status(409).json({ error: "Duplicate value", field: Object.keys(err.keyValue) });
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

/* ---------- Start ---------- */
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => app.listen(process.env.PORT || 5000, () => console.log("Server running")))
  .catch((e) => { console.error("DB connection failed:", e.message); process.exit(1); });
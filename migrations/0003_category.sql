-- v3: user-assigned product categories. NULL = uncategorized; the UI only
-- renders category sections once at least one product has a category.
ALTER TABLE products ADD COLUMN category TEXT;

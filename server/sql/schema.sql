CREATE TABLE IF NOT EXISTS workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'INR',
  gstin TEXT NOT NULL DEFAULT '24AAACN1234F1Z5', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','accountant','viewer')), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL, email TEXT NOT NULL, company TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
  gstin TEXT NOT NULL DEFAULT '', billing_address TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,email)
);
CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', unit_price NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),
  tax_rate NUMERIC(5,2) NOT NULL DEFAULT 18 CHECK (tax_rate >= 0 AND tax_rate <= 100),
  unit TEXT NOT NULL DEFAULT 'unit', active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,name)
);
CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id), invoice_number TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Sent'
    CHECK (status IN ('Draft','Sent','Partial','Paid','Void')),
  issue_date DATE NOT NULL DEFAULT CURRENT_DATE, due_date DATE NOT NULL, currency TEXT NOT NULL DEFAULT 'INR',
  notes TEXT NOT NULL DEFAULT '', subtotal NUMERIC(12,2) NOT NULL DEFAULT 0, tax_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  total NUMERIC(12,2) NOT NULL DEFAULT 0, created_by UUID REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(workspace_id,invoice_number)
);
CREATE TABLE IF NOT EXISTS invoice_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id) ON DELETE SET NULL, name TEXT NOT NULL, quantity NUMERIC(10,2) NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0), tax_rate NUMERIC(5,2) NOT NULL DEFAULT 18 CHECK (tax_rate >= 0 AND tax_rate <= 100),
  line_subtotal NUMERIC(12,2) NOT NULL, line_tax NUMERIC(12,2) NOT NULL, line_total NUMERIC(12,2) NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0), method TEXT NOT NULL CHECK (method IN ('Bank transfer','UPI','Card','Cash','Other')),
  reference TEXT NOT NULL DEFAULT '', paid_at TIMESTAMPTZ NOT NULL DEFAULT now(), recorded_by UUID REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS invoice_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES users(id), action TEXT NOT NULL, details TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS invoice_counters (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, year INTEGER NOT NULL, last_number INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(workspace_id,year)
);
CREATE INDEX IF NOT EXISTS invoices_workspace_date_idx ON invoices(workspace_id,issue_date DESC);
CREATE INDEX IF NOT EXISTS invoices_client_idx ON invoices(client_id);
CREATE INDEX IF NOT EXISTS payments_invoice_idx ON payments(invoice_id,paid_at DESC);

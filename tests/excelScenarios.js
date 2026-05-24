// tests/excelScenarios.js — EXCEL_TEST_SCENARIO=sales

const SCENARIOS = {
  sales: {
    id: 'sales',
    label: 'Q3 Sales Analytics Workbook',
    outputBasename: 'sales_analytics_q3.xlsx',
    request: `Build a professional Q3 2024 sales analytics workbook (SheetJS / xlsx).

Requirements:
1. "Sales Transactions" — transaction-level detail: at least 28 data rows (plus header).
   Columns: Date, Region, Product, SKU, Units, Unit Price, Revenue.
   Revenue must be Excel formulas (Units * Unit Price) per row, not hardcoded numbers.
2. "Product Catalog" — at least 12 products: Product, Category, List Price, Cost, Target Margin %.
   Include a Margin % column as formulas: (List Price - Cost) / List Price.
3. "Regional Summary" — one row per region (at least 5 regions) with SUMIF formulas pulling from Sales Transactions (total units, total revenue per region).
4. "Analysis Dashboard" — KPI block with formulas referencing other sheets:
   - Total Revenue (SUM of transaction revenue column)
   - Average Deal Size (AVERAGE revenue)
   - Total Units (SUM units)
   - Best Region (can be computed in JS or a simple formula)
   - Product Count (COUNTA on product catalog)
   Assume Sales Transactions data occupies Excel rows 2–31 (30 data rows) for cross-sheet references.

Use realistic business data. Numeric columns as numbers in AOA; formulas in the formulas array.`,
    planSections: [
      {
        name: 'sales_transactions',
        functionName: 'buildSalesTransactions',
        sheetName: 'Sales Transactions',
        minRows: 25,
        description:
          'At least 28 transaction rows. Columns Date, Region, Product, SKU, Units, Unit Price. Use helpers.withRevenueColumn("Sales Transactions", rows) — adds Revenue formulas (E*F per row).',
      },
      {
        name: 'product_catalog',
        functionName: 'buildProductCatalog',
        sheetName: 'Product Catalog',
        minRows: 10,
        description:
          'At least 10 products (header + 10 rows minimum). Use helpers.withMarginPercentColumn("Product Catalog", rows) for List Price, Cost, and Margin % formulas.',
      },
      {
        name: 'regional_summary',
        functionName: 'buildRegionalSummary',
        sheetName: 'Regional Summary',
        minRows: 5,
        description:
          'Regions from the transaction data. Use helpers.sheetPayload with formulas: SUMIF on Sales Transactions region column (B) and revenue (G). At least 5 regions.',
      },
      {
        name: 'analysis_dashboard',
        functionName: 'buildAnalysisDashboard',
        sheetName: 'Analysis Dashboard',
        minRows: 8,
        description:
          'KPI table: Metric, Value. Use helpers.sheetPayload(name, rows, formulas) with cross-sheet SUM/AVERAGE/COUNTA formulas referencing Sales Transactions rows 2–31 and Product Catalog.',
      },
    ],
  },
};

function listScenarios() {
  return Object.values(SCENARIOS).map(s => ({ id: s.id, label: s.label }));
}

function getScenario(id) {
  const key = (id || process.env.EXCEL_TEST_SCENARIO || 'sales').trim().toLowerCase();
  const scenario = SCENARIOS[key];
  if (!scenario) throw new Error(`Unknown EXCEL_TEST_SCENARIO "${key}". Available: ${Object.keys(SCENARIOS).join(', ')}`);
  return scenario;
}

module.exports = { getScenario, listScenarios };

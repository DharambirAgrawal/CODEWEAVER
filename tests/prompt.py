"""
Single-prompt input for the local runner.
Set PROMPT to ONE prompt (Word, Excel, Chart, or CSV) and run `npm test`.
"""

# Paste ONE prompt here
PROMPT = """
Create a detailed board-level Q2 2026 performance report for Blue Harbor Analytics.
Output a Word document named blue_harbor_q2_2026_report.docx.

Required sections:
1) Cover page: title, subtitle, date, confidentiality note.
2) Executive summary: 5-7 paragraphs, each 2-4 sentences, concise but content-rich.
3) Key metrics dashboard: a table with 12 KPIs (ARR, NRR, GRR, churn, CAC, LTV, CAC payback, NPS, gross margin, EBITDA margin, headcount, cash runway) with Q2 values and QoQ deltas.
4) Financial highlights: a table with Q1/Q2/Q3 2026 Revenue, Opex, Gross Profit, Net Income, EBITDA in millions. Add 2 analysis paragraphs.
5) Regional performance: a table by region (NA, EMEA, APAC, LATAM, ANZ) with revenue, growth %, pipeline coverage. Add a paragraph with insights.
6) Product performance: cover three products with a short description, a metrics table per product, and one analysis paragraph each.
7) Customer wins: 5 brief case-study blurbs with industry, problem, result.
8) Risks and mitigations: a 3-column table (Risk, Likelihood, Mitigation) with at least 6 rows.
9) Q3-Q4 goals: numbered list of 10 measurable goals.
10) Appendix: glossary + assumptions + methodology.

Formatting requirements:
- Use clear Heading 1 and Heading 2 structure.
- Multiple tables across the document.
- Realistic but fictional numbers.
- Professional, executive tone.
"""

# Example prompts (copy one into PROMPT if you want a different output type)

# Excel example:
# Create an Excel workbook named revops_dashboard.xlsx using Python openpyxl.
#
# Sheets:
# 1) Raw_Data: 320 rows of subscription transactions with columns Date, Region, Segment, Plan, Account_ID, MRR, Expansion_MRR, Churn_MRR, Sales_Rep, Source.
# 2) Cohorts: summarize by Start_Month and Region. Use formulas (SUMIFS, COUNTIFS, AVERAGEIFS) to compute Total_MRR, Churn_Rate, NRR.
# 3) Pipeline: 140 rows with Deal_ID, Region, Segment, Stage, Amount, Close_Probability, Expected_Close_Date. Compute Weighted_Pipeline = Amount * Close_Probability (formula).
# 4) Forecast: monthly forecast for next 6 months using Weighted_Pipeline + current MRR growth assumptions. Include sensitivity scenarios +/-10%.
# 5) Dashboard: KPI block (Total MRR, NRR, Gross Churn %, Net New MRR, Best Region, Product Count) with formulas referencing other sheets.
# 6) Charts: add charts that reference summary sheets:
#    - Column chart: Top 10 accounts by MRR
#    - Line chart: Monthly MRR trend
#    - Combo chart: Units vs Revenue by region (bar + line)
#    - Pie chart: Revenue share by segment
#
# Rules:
# - Use formulas, not hardcoded results, for calculated fields.
# - Use realistic numeric values and dates.
# - Apply currency and percent formats where appropriate.

# Chart example:
# Generate a chart image named energy_demand_forecast.png using Python matplotlib.
#
# Requirements:
# - 180 days of historical daily demand (MWh) and a 30-day forecast.
# - Two lines: historical and forecast.
# - 80% confidence band around forecast.
# - Annotate three events (heatwave, maintenance outage, policy change) with dates and short labels.
# - Add a small text box with average demand, max demand, and forecast peak.
# - Use a clean professional style and 16:9 aspect ratio.

# CSV example:
# Create a CSV file named supplier_compliance_audit.csv with 240 rows.
# Columns: Supplier_ID, Region, Category, Audit_Date, Compliance_Score, Critical_Issues, Corrective_Action_Due, Risk_Tier.
# Ensure at least 20% of rows have Critical_Issues > 0.
# Use realistic values and a mix of regions and categories.

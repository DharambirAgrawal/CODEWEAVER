// Single-prompt input for the local runner.
// Set PROMPT to ONE prompt (Word, Excel, Chart, or CSV) and run `npm test`.

// const PROMPT = `
// Create an Excel workbook named revops_dashboard.xlsx using Python openpyxl.

// Sheets:
// 1) Raw_Data: 320 rows of subscription transactions with columns Date, Region, Segment, Plan, Account_ID, MRR, Expansion_MRR, Churn_MRR, Sales_Rep, Source.
// 2) Cohorts: summarize by Start_Month and Region. Use formulas (SUMIFS, COUNTIFS, AVERAGEIFS) to compute Total_MRR, Churn_Rate, NRR.
// 3) Pipeline: 140 rows with Deal_ID, Region, Segment, Stage, Amount, Close_Probability, Expected_Close_Date. Compute Weighted_Pipeline = Amount * Close_Probability (formula).
// 4) Forecast: monthly forecast for next 6 months using Weighted_Pipeline + current MRR growth assumptions. Include sensitivity scenarios +/-10%.
// 5) Dashboard: KPI block (Total MRR, NRR, Gross Churn %, Net New MRR, Best Region, Product Count) with formulas referencing other sheets.
// 6) Charts: add charts that reference summary sheets:
//    - Column chart: Top 10 accounts by MRR
//    - Line chart: Monthly MRR trend
//    - Combo chart: Units vs Revenue by region (bar + line)
//    - Pie chart: Revenue share by segment

// Rules:
// - Use formulas, not hardcoded results, for calculated fields.
// - Use realistic numeric values and dates.
// - Apply currency and percent formats where appropriate.
// `;







const PROMPT = `
Create a forensic investigation report for a fictional ransomware attack on a manufacturing company.

Output file:
ransomware_investigation_report.docx

Requirements:

1. Incident Timeline
   - Minute-by-minute attack chronology.
   - Initial access, privilege escalation, lateral movement, encryption phase.

2. Affected Assets
   - Table with hostname, department, OS, criticality, status.

3. Attack Chain Analysis
   - MITRE ATT&CK techniques used.
   - Evidence supporting each stage.

4. Log Analysis
   - Generate realistic firewall, VPN, and authentication log excerpts.
   - Highlight suspicious events.

5. Indicators of Compromise
   - IP addresses
   - Domains
   - File hashes
   - Registry changes

6. Root Cause Analysis

7. Containment Actions

8. Recovery Plan

9. Lessons Learned

10. Appendix
    - Technical evidence summary
`
// // Example prompts (copy one into PROMPT if you want a different output type)

// // Excel example:
// // const PROMPT = `
// Create an Excel workbook named revops_dashboard.xlsx using Python openpyxl.

// Sheets:
// 1) Raw_Data: 320 rows of subscription transactions with columns Date, Region, Segment, Plan, Account_ID, MRR, Expansion_MRR, Churn_MRR, Sales_Rep, Source.
// 2) Cohorts: summarize by Start_Month and Region. Use formulas (SUMIFS, COUNTIFS, AVERAGEIFS) to compute Total_MRR, Churn_Rate, NRR.
// 3) Pipeline: 140 rows with Deal_ID, Region, Segment, Stage, Amount, Close_Probability, Expected_Close_Date. Compute Weighted_Pipeline = Amount * Close_Probability (formula).
// 4) Forecast: monthly forecast for next 6 months using Weighted_Pipeline + current MRR growth assumptions. Include sensitivity scenarios +/-10%.
// 5) Dashboard: KPI block (Total MRR, NRR, Gross Churn %, Net New MRR, Best Region, Product Count) with formulas referencing other sheets.
// 6) Charts: add charts that reference summary sheets:
//    - Column chart: Top 10 accounts by MRR
//    - Line chart: Monthly MRR trend
//    - Combo chart: Units vs Revenue by region (bar + line)
//    - Pie chart: Revenue share by segment

// Rules:
// - Use formulas, not hardcoded results, for calculated fields.
// - Use realistic numeric values and dates.
// - Apply currency and percent formats where appropriate.
// `

// Chart example:
// const PROMPT = `
// Generate a chart image named energy_demand_forecast.png using Python matplotlib.
// Requirements:
// - 180 days of historical daily demand (MWh) and a 30-day forecast.
// - Two lines: historical and forecast. 80% confidence band around forecast.
// - Annotate three events (heatwave, maintenance outage, policy change).
// - Use a clean professional style and 16:9 aspect ratio.
// `

// CSV example:
// const PROMPT = `
// Create a CSV file named supplier_compliance_audit.csv with 240 rows.
// Columns: Supplier_ID, Region, Category, Audit_Date, Compliance_Score, Critical_Issues, Corrective_Action_Due, Risk_Tier.
// Ensure at least 20% of rows have Critical_Issues > 0.
// `

module.exports = { PROMPT };
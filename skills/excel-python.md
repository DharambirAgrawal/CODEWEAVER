---
name: excel-python
description: "CodeWeaver skill for creating Excel workbooks (.xlsx) in Python using openpyxl and pandas. Use for chunked generation via the planned pipeline or local pyExcelTest harness."
---

# Excel spreadsheet creation (Python — openpyxl / pandas)

Reference for CodeWeaver when generating **new** `.xlsx` files with Python in the planned pipeline or `test:pyexcel` local harness.

## CodeWeaver execution model

| Topic | Rule |
|--------|------|
| **Output path** | Save to **`/workspace/<outputFile>`** (Execify) or `OUTPUT_PATH` env var (local test). Example: `wb.save('/workspace/output.xlsx')` |
| **Success log** | Print: `SUCCESS: saved /workspace/<outputFile>` — validator checks for this |
| **Library** | Use `openpyxl` for formatting/formulas, `pandas` for bulk data. Do NOT use `xlrd`, `xlwt`, or Node libraries. |
| **Install** | Both `openpyxl` and `pandas` are pre-installed. Do NOT run `pip install`. |
| **Formulas** | Write as strings: `ws['B2'] = '=SUM(B2:B9)'`. Cross-sheet: `"='Sheet Name'!G2"` |
| **Final step only** | Only the final step calls `wb.save(...)`. Middle steps return data structures. |

### Common mistakes in CodeWeaver

| Mistake | Fix |
|---------|-----|
| Saving to `output.xlsx` in cwd | Use `/workspace/<task.outputFile>` or `OUTPUT_PATH` |
| `wb.save()` in middle steps | Only the final step saves the workbook |
| Hardcoded computed values | Use Excel formula strings instead |
| `import openpyxl` in middle steps if setup imported it | Match orchestrator conventions — check what's already imported |
| Inventing openpyxl APIs | Stick to `Workbook`, `load_workbook`, `.active`, `.create_sheet`, `ws.append()`, `ws['A1']` |

---

# Requirements for Outputs

## All Excel files

### Professional Font
- Use a consistent, professional font (e.g., Arial, Times New Roman) for all deliverables unless otherwise instructed by the user

### Zero Formula Errors
- Every Excel model MUST be delivered with ZERO formula errors (#REF!, #DIV/0!, #VALUE!, #N/A, #NAME?)

### Preserve Existing Templates (when updating templates)
- Study and EXACTLY match existing format, style, and conventions when modifying files
- Never impose standardized formatting on files with established patterns
- Existing template conventions ALWAYS override these guidelines

## Financial models

### Color Coding Standards
Unless otherwise stated by the user or existing template

#### Industry-Standard Color Conventions
- **Blue text (RGB: 0,0,255)**: Hardcoded inputs, and numbers users will change for scenarios
- **Black text (RGB: 0,0,0)**: ALL formulas and calculations
- **Green text (RGB: 0,128,0)**: Links pulling from other worksheets within same workbook
- **Red text (RGB: 255,0,0)**: External links to other files
- **Yellow background (RGB: 255,255,0)**: Key assumptions needing attention or cells that need to be updated

### Number Formatting Standards

#### Required Format Rules
- **Years**: Format as text strings (e.g., "2024" not "2,024")
- **Currency**: Use $#,##0 format; ALWAYS specify units in headers ("Revenue ($mm)")
- **Zeros**: Use number formatting to make all zeros "-", including percentages (e.g., "$#,##0;($#,##0);-")
- **Percentages**: Default to 0.0% format (one decimal)
- **Multiples**: Format as 0.0x for valuation multiples (EV/EBITDA, P/E)
- **Negative numbers**: Use parentheses (123) not minus -123

### Formula Construction Rules

#### Assumptions Placement
- Place ALL assumptions (growth rates, margins, multiples, etc.) in separate assumption cells
- Use cell references instead of hardcoded values in formulas
- Example: Use =B5*(1+$B$6) instead of =B5*1.05

#### Formula Error Prevention
- Verify all cell references are correct
- Check for off-by-one errors in ranges
- Ensure consistent formulas across all projection periods
- Test with edge cases (zero values, negative numbers)
- Verify no unintended circular references

#### Documentation Requirements for Hardcodes
- Comment or in cells beside (if end of table). Format: "Source: [System/Document], [Date], [Specific Reference], [URL if applicable]"
- Examples:
  - "Source: Company 10-K, FY2024, Page 45, Revenue Note, [SEC EDGAR URL]"
  - "Source: Company 10-Q, Q2 2025, Exhibit 99.1, [SEC EDGAR URL]"
  - "Source: Bloomberg Terminal, 8/15/2025, AAPL US Equity"
  - "Source: FactSet, 8/20/2025, Consensus Estimates Screen"

# XLSX creation, editing, and analysis

## Overview

A user may ask you to create, edit, or analyze the contents of an .xlsx file. You have different tools and workflows available for different tasks.

## Important Requirements

**Formula strings in openpyxl**: openpyxl writes formulas as strings. They are evaluated when the file is opened in Excel or LibreOffice. For the local test harness, formula validation is done structurally (checking the formula string is present and correctly formed) rather than by computing the result.

## Reading and analyzing data

### Quick inspection with openpyxl
```python
from openpyxl import load_workbook
wb = load_workbook('file.xlsx', data_only=True)
for name in wb.sheetnames:
    ws = wb[name]
    print(f'Sheet: {name} — {ws.max_row} rows x {ws.max_column} cols')
```

### Data analysis with pandas
For data analysis, visualization, and basic operations, use **pandas** which provides powerful data manipulation capabilities:

```python
import pandas as pd

# Read Excel
df = pd.read_excel('file.xlsx')  # Default: first sheet
all_sheets = pd.read_excel('file.xlsx', sheet_name=None)  # All sheets as dict

# Analyze
df.head()      # Preview data
df.info()      # Column info
df.describe()  # Statistics

# Write Excel
df.to_excel('output.xlsx', index=False)
```

## Excel File Workflows

## CRITICAL: Use Formulas, Not Hardcoded Values

**Always use Excel formulas instead of calculating values in Python and hardcoding them.** This ensures the spreadsheet remains dynamic and updateable.

### ❌ WRONG - Hardcoding Calculated Values
```python
# Bad: Calculating in Python and hardcoding result
total = df['Sales'].sum()
sheet['B10'] = total  # Hardcodes 5000

# Bad: Computing growth rate in Python
growth = (df.iloc[-1]['Revenue'] - df.iloc[0]['Revenue']) / df.iloc[0]['Revenue']
sheet['C5'] = growth  # Hardcodes 0.15

# Bad: Python calculation for average
avg = sum(values) / len(values)
sheet['D20'] = avg  # Hardcodes 42.5
```

### ✅ CORRECT - Using Excel Formulas
```python
# Good: Let Excel calculate the sum
sheet['B10'] = '=SUM(B2:B9)'

# Good: Growth rate as Excel formula
sheet['C5'] = '=(C4-C2)/C2'

# Good: Average using Excel function
sheet['D20'] = '=AVERAGE(D2:D19)'
```

This applies to ALL calculations - totals, percentages, ratios, differences, etc. The spreadsheet should be able to recalculate when source data changes.

## Common Workflow (CodeWeaver chunked pipeline)
1. **Step 1 (setup)**: Import libraries, define constants, create workbook object
2. **Middle steps**: Each step builds one sheet or section — return data dict `{'sheet_name': ..., 'rows': [...], 'formulas': [...]}`
3. **Final step**: Assemble workbook, append all sheets, save to `/workspace/<outputFile>`
4. **Print success**: `print(f'SUCCESS: saved /workspace/<outputFile>')`

### Creating new Excel files

```python
# Using openpyxl for formulas and formatting
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment

wb = Workbook()
sheet = wb.active

# Add data
sheet['A1'] = 'Hello'
sheet['B1'] = 'World'
sheet.append(['Row', 'of', 'data'])

# Add formula
sheet['B2'] = '=SUM(A1:A10)'

# Formatting
sheet['A1'].font = Font(bold=True, color='FF0000')
sheet['A1'].fill = PatternFill('solid', start_color='FFFF00')
sheet['A1'].alignment = Alignment(horizontal='center')

# Column width
sheet.column_dimensions['A'].width = 20

wb.save('output.xlsx')
```

### Editing existing Excel files

```python
# Using openpyxl to preserve formulas and formatting
from openpyxl import load_workbook

# Load existing file
wb = load_workbook('existing.xlsx')
sheet = wb.active  # or wb['SheetName'] for specific sheet

# Working with multiple sheets
for sheet_name in wb.sheetnames:
    sheet = wb[sheet_name]
    print(f"Sheet: {sheet_name}")

# Modify cells
sheet['A1'] = 'New Value'
sheet.insert_rows(2)  # Insert row at position 2
sheet.delete_cols(3)  # Delete column 3

# Add new sheet
new_sheet = wb.create_sheet('NewSheet')
new_sheet['A1'] = 'Data'

wb.save('modified.xlsx')
```

## Formula patterns in openpyxl

```python
from openpyxl import Workbook
wb = Workbook()
ws = wb.active

# Write data rows
for i, row in enumerate(data_rows, start=2):
    ws.append(row)

# Set formulas (written as strings, evaluated by Excel on open)
for row_num in range(2, len(data_rows) + 2):
    ws[f'G{row_num}'] = f'=E{row_num}*F{row_num}'  # Revenue = Units * Price

# Cross-sheet reference
ws['B2'] = "=SUMIF('Sales Transactions'!B:B,A2,'Sales Transactions'!G:G)"

wb.save('/workspace/output.xlsx')
print('SUCCESS: saved /workspace/output.xlsx')
```

## Chart patterns in openpyxl (via CodeWeaver payload)

When using the `test:pyexcel` local harness, sheet builders can return an optional `charts` list in the payload dictionary to embed charts directly in the Excel file.

### Chart payload structure
```python
    return {
        'sheet_name': 'Dashboard',
        'rows': [
            ['Region', 'Q1 Sales', 'Q2 Sales'],
            ['North', 12000, 15000],
            ['South', 14000, 16000],
            ['East', 11000, 13000],
            ['West', 15000, 17000]
        ],
        'formulas': [],
        'charts': [
            {
                'type': 'bar',        # 'bar' | 'line' | 'pie'
                'bar_type': 'col',    # 'col' (vertical columns) | 'bar' (horizontal bars)
                'title': 'Sales by Region',
                'cell': 'E2',         # Top-left cell where chart is placed
                'width': 15,          # Chart width in cm (optional)
                'height': 10,         # Chart height in cm (optional)
                'x_title': 'Region',  # X-axis label (optional)
                'y_title': 'Sales',   # Y-axis label (optional)
                'style': 10,          # Chart style ID (optional, e.g. 10)
                # data_reference specifies the numerical data range (columns & rows)
                # Note: openpyxl uses 1-based indexing. Columns: A=1, B=2, C=3, etc.
                'data_reference': {
                    'min_col': 2,     # Start column (B = Q1 Sales)
                    'min_row': 1,     # Start row (includes header row 1 to read labels)
                    'max_col': 3,     # End column (C = Q2 Sales)
                    'max_row': 5      # End row (includes North, South, East, West)
                },
                # categories_reference specifies the labels for the categories (e.g. x-axis)
                'categories_reference': {
                    'min_col': 1,     # Start column (A = Region)
                    'min_row': 2,     # Start row (skip header)
                    'max_col': 1,     # End column (A = Region)
                    'max_row': 5      # End row
                }
            }
        ]
    }
```

## Formula Verification Checklist

Quick checks to ensure formulas work correctly:

### Essential Verification
- [ ] **Test 2-3 sample references**: Verify they pull correct values before building full model
- [ ] **Column mapping**: Confirm Excel columns match (e.g., column 64 = BL, not BK)
- [ ] **Row offset**: Remember Excel rows are 1-indexed (DataFrame row 5 = Excel row 6)

### Common Pitfalls
- [ ] **NaN handling**: Check for null values with `pd.notna()`
- [ ] **Far-right columns**: FY data often in columns 50+ 
- [ ] **Multiple matches**: Search all occurrences, not just first
- [ ] **Division by zero**: Check denominators before using `/` in formulas (#DIV/0!)
- [ ] **Wrong references**: Verify all cell references point to intended cells (#REF!)
- [ ] **Cross-sheet references**: Use correct format (Sheet1!A1) for linking sheets

### Formula Testing Strategy
- [ ] **Start small**: Test formulas on 2-3 cells before applying broadly
- [ ] **Verify dependencies**: Check all cells referenced in formulas exist
- [ ] **Test edge cases**: Include zero, negative, and very large values

### Interpreting scripts/recalc.py Output
The script returns JSON with error details:
```json
{
  "status": "success",           // or "errors_found"
  "total_errors": 0,              // Total error count
  "total_formulas": 42,           // Number of formulas in file
  "error_summary": {              // Only present if errors found
    "#REF!": {
      "count": 2,
      "locations": ["Sheet1!B5", "Sheet1!C10"]
    }
  }
}
```

## Best Practices

### Library Selection
- **pandas**: Best for data analysis, bulk operations, and simple data export
- **openpyxl**: Best for complex formatting, formulas, and Excel-specific features

### Working with openpyxl
- Cell indices are 1-based (row=1, column=1 refers to cell A1)
- Use `data_only=True` to read calculated values: `load_workbook('file.xlsx', data_only=True)`
- **Warning**: If opened with `data_only=True` and saved, formulas are replaced with values and permanently lost
- For large files: Use `read_only=True` for reading or `write_only=True` for writing
- Formulas are preserved but not evaluated - use scripts/recalc.py to update values

### Working with pandas
- Specify data types to avoid inference issues: `pd.read_excel('file.xlsx', dtype={'id': str})`
- For large files, read specific columns: `pd.read_excel('file.xlsx', usecols=['A', 'C', 'E'])`
- Handle dates properly: `pd.read_excel('file.xlsx', parse_dates=['date_column'])`

## Code Style Guidelines
**IMPORTANT**: When generating Python code for Excel operations:
- Write minimal, concise Python code without unnecessary comments
- Avoid verbose variable names and redundant operations
- Avoid unnecessary print statements

**For Excel files themselves**:
- Add comments to cells with complex formulas or important assumptions
- Document data sources for hardcoded values
- Include notes for key calculations and model sections
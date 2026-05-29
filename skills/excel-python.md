---
name: excel-python
description: "CodeWeaver skill for creating Excel workbooks (.xlsx) in Python using openpyxl and pandas. Use for chunked generation via the planned pipeline or local pyExcelTest harness."
---

# Excel spreadsheet creation (Python - openpyxl / pandas)

Reference for CodeWeaver when generating new `.xlsx` files with Python.

## CodeWeaver execution model

| Topic | Rule |
|--------|------|
| Output path | Save to `OUTPUT_PATH` when it exists; otherwise save to `/workspace/<outputFile>`. |
| Success log | Final step prints `SUCCESS: saved <path>`. |
| Library | Use `openpyxl` for workbook creation, formulas, formatting, and charts. Use `pandas` only for bulk tabular data if useful. |
| Install | `openpyxl` and `pandas` are pre-installed. Do not run `pip install`. |
| Formulas | Write Excel formulas as strings, e.g. `ws['B2'] = '=SUM(B2:B9)'`. |
| Step contract | Follow the current step's declared return type exactly. Middle steps do not save files. The final step saves the workbook. |

## Supported imports

Use only stable openpyxl imports that exist in openpyxl 3.x:

```python
from openpyxl import Workbook, load_workbook
from openpyxl.chart import BarChart, LineChart, PieChart, Reference
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.styles.numbers import FORMAT_CURRENCY_USD_SIMPLE, FORMAT_PERCENTAGE
from openpyxl.utils import get_column_letter
```

For most number formatting, prefer literal Excel format strings instead of importing constants:

```python
cell.number_format = "$#,##0.00"
cell.number_format = "0.0%"
cell.number_format = "#,##0"
```

## Invalid imports and APIs

Never import or use these. They do not exist in common openpyxl versions and will fail runtime probes.

| Invalid | Use instead |
|---------|-------------|
| `from openpyxl.styles import FontProperties` | `from openpyxl.styles import Font` |
| `from openpyxl.styles import NumberFormat` | `cell.number_format = "$#,##0.00"` |
| `from openpyxl.formatting.number import ...` | `from openpyxl.styles.numbers import ...` or literal format strings |
| `NumberFormatDescriptor.from_str(...)` | literal format strings assigned to `cell.number_format` |

## Common mistakes in CodeWeaver

| Mistake | Fix |
|---------|-----|
| Saving in a middle step | Only the final step calls `wb.save(...)`. |
| Hardcoded calculated values | Use Excel formula strings so the sheet recalculates. |
| Inventing openpyxl APIs | Use only the imports and APIs listed above. |
| Wrong output path | Use `OUTPUT_PATH` if defined, else `/workspace/<outputFile>`. |
| Returning the wrong object | Match the step return contract exactly. |

## Workbook pattern

```python
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment

def build_workbook():
    wb = Workbook()
    ws = wb.active
    ws.title = "Summary"

    ws.append(["Metric", "Value"])
    ws.append(["Revenue", 125000])
    ws.append(["Growth", 0.125])
    ws["B2"].number_format = "$#,##0"
    ws["B3"].number_format = "0.0%"

    for cell in ws[1]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="1F4E78")
        cell.alignment = Alignment(horizontal="center")

    ws["B4"] = "=SUM(B2:B2)"
    return wb
```

## Formula patterns

Formulas are strings. Excel evaluates them when the workbook is opened.

```python
ws["G2"] = "=E2*F2"
ws["B10"] = "=SUM(B2:B9)"
ws["C10"] = "=AVERAGE(C2:C9)"
ws["D2"] = "=SUMIF(Raw_Data!B:B,A2,Raw_Data!F:F)"
ws["E2"] = "=IFERROR((C2-B2)/B2,0)"
```

Use formulas for totals, rates, ratios, variance, forecast values, weighted pipeline, and KPI blocks. Do not calculate those values in Python and paste the result when the spreadsheet should remain dynamic.

## Formatting patterns

```python
ws.column_dimensions["A"].width = 24
ws.freeze_panes = "A2"
ws.auto_filter.ref = ws.dimensions

for row in ws.iter_rows(min_row=2, min_col=5, max_col=5):
    for cell in row:
        cell.number_format = "$#,##0"

for row in ws.iter_rows(min_row=2, min_col=6, max_col=6):
    for cell in row:
        cell.number_format = "0.0%"
```

## Chart patterns

```python
from openpyxl.chart import BarChart, LineChart, PieChart, Reference

chart = BarChart()
chart.title = "Revenue by Region"
chart.y_axis.title = "Revenue"
chart.x_axis.title = "Region"

data = Reference(ws, min_col=2, min_row=1, max_row=6)
cats = Reference(ws, min_col=1, min_row=2, max_row=6)
chart.add_data(data, titles_from_data=True)
chart.set_categories(cats)
ws.add_chart(chart, "E2")
```

## Validation checklist

- Verify all referenced sheets and cells exist.
- Use `IFERROR` or denominator checks for division formulas.
- Keep formulas relative or absolute intentionally, e.g. `$B$2` for assumptions.
- Use one-based row and column indexes with openpyxl.
- Do not open a formula workbook with `data_only=True` and then save it; that can remove formulas.

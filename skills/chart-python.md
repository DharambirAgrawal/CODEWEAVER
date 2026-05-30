---
name: chart-python
description: "CodeWeaver skill for generating chart/image files (.png, .jpg, .svg) using Python matplotlib and seaborn. Use for any chart, graph, plot, or data visualization task."
---

# Chart / image generation (Python — matplotlib / seaborn)

Reference for CodeWeaver when generating **chart image files** (`.png`, `.jpg`, `.svg`) with Python in the planned pipeline or `test:chart` local harness.

## CodeWeaver execution model

| Topic | Rule |
|--------|------|
| **Output path** | Save to **`/workspace/<outputFile>`** (Execify) or `OUTPUT_PATH` env var (local test). |
| **Success log** | Print: `SUCCESS: saved /workspace/<outputFile>` — validator checks for this |
| **Library** | Use `matplotlib` (always available) and `seaborn` for styled charts. Do NOT use plotly unless explicitly requested. |
| **Install** | `matplotlib`, `seaborn`, `numpy`, `pandas` are pre-installed. Do NOT run `pip install`. |
| **Backend** | Always set `matplotlib.use('Agg')` before importing pyplot — Execify has no display. |
| **DPI** | Use `dpi=150` or higher for clean output. Default figure size: `(12, 7)`. |
| **Final step** | Save with `plt.savefig('/workspace/<outputFile>', dpi=150, bbox_inches='tight')` then `plt.close()`. |

### Common mistakes in CodeWeaver

| Mistake | Fix |
|---------|-----|
| Missing `matplotlib.use('Agg')` | Add before `import matplotlib.pyplot as plt` or the script crashes headlessly |
| Saving to cwd (`chart.png`) | Use `/workspace/<task.outputFile>` or `OUTPUT_PATH` |
| `plt.show()` in code | Remove it — no display available in Execify |
| Forgetting `plt.close()` | Always close after save to free memory |
| Missing tight layout | Use `bbox_inches='tight'` in `savefig` to prevent label clipping |
| Using `plt.figure()` after `plt.close()` without re-opening | Call `fig, ax = plt.subplots(...)` at the start of each chart |

---

## Core API

### Setup (always first)

```python
import matplotlib
matplotlib.use('Agg')  # MUST be before pyplot import
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
```

### Figure and save

```python
fig, ax = plt.subplots(figsize=(12, 7))

# ... draw chart on ax ...

ax.set_title('Chart Title', fontsize=16, fontweight='bold', pad=15)
ax.set_xlabel('X Label', fontsize=12)
ax.set_ylabel('Y Label', fontsize=12)
ax.legend(loc='best')

plt.tight_layout()
plt.savefig('/workspace/output.png', dpi=150, bbox_inches='tight')
plt.close(fig)
print('SUCCESS: saved /workspace/output.png')
```

---

## Chart patterns

### Bar chart (categorical)

```python
fig, ax = plt.subplots(figsize=(12, 7))
categories = ['North', 'South', 'East', 'West']
values = [420000, 380000, 310000, 290000]
colors = ['#2196F3', '#4CAF50', '#FF9800', '#9C27B0']
bars = ax.bar(categories, values, color=colors, edgecolor='white', linewidth=0.5)

# Value labels on bars
for bar, val in zip(bars, values):
    ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 5000,
            f'${val:,.0f}', ha='center', va='bottom', fontsize=10, fontweight='bold')

ax.set_title('Revenue by Region — Q3 2024', fontsize=16, fontweight='bold')
ax.set_ylabel('Revenue ($)', fontsize=12)
ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda x, _: f'${x:,.0f}'))
ax.set_facecolor('#f8f9fa')
fig.patch.set_facecolor('white')
ax.grid(axis='y', alpha=0.3)
plt.tight_layout()
```

### Line chart (time series)

```python
fig, ax = plt.subplots(figsize=(14, 7))
months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
          'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
revenue = [120, 135, 148, 162, 155, 178, 190, 183, 201, 215, 228, 245]
forecast = [None]*6 + [178, 192, 208, 222, 235, 250]

ax.plot(months, revenue, 'o-', color='#2196F3', linewidth=2.5,
        markersize=8, label='Actual', zorder=3)
ax.fill_between(range(len(months)), revenue, alpha=0.1, color='#2196F3')

ax.set_title('Monthly Revenue Trend', fontsize=16, fontweight='bold')
ax.set_xlabel('Month', fontsize=12)
ax.set_ylabel('Revenue ($K)', fontsize=12)
ax.legend()
ax.grid(alpha=0.3)
```

### Pie / donut chart

```python
fig, ax = plt.subplots(figsize=(10, 8))
labels = ['Product A', 'Product B', 'Product C', 'Product D', 'Other']
sizes = [35, 25, 20, 12, 8]
colors = ['#2196F3', '#4CAF50', '#FF9800', '#9C27B0', '#607D8B']
explode = [0.05, 0, 0, 0, 0]  # slightly separate the largest slice

wedges, texts, autotexts = ax.pie(
    sizes, labels=labels, colors=colors, explode=explode,
    autopct='%1.1f%%', startangle=90, pctdistance=0.85,
    wedgeprops={'edgecolor': 'white', 'linewidth': 2}
)
# Donut hole
centre_circle = plt.Circle((0, 0), 0.65, fc='white')
ax.add_patch(centre_circle)
```

### Seaborn heatmap

```python
import seaborn as sns
import numpy as np

fig, ax = plt.subplots(figsize=(12, 8))
data = np.random.rand(8, 6)
df = pd.DataFrame(data,
                  index=['Mon','Tue','Wed','Thu','Fri','Sat','Sun','Avg'],
                  columns=['Jan','Feb','Mar','Apr','May','Jun'])
sns.heatmap(df, annot=True, fmt='.2f', cmap='YlOrRd',
            linewidths=0.5, ax=ax, cbar_kws={'label': 'Value'})
ax.set_title('Performance Heatmap', fontsize=16, fontweight='bold')
```

### Multi-panel (subplots grid)

```python
fig, axes = plt.subplots(2, 2, figsize=(16, 12))
fig.suptitle('Dashboard Overview', fontsize=18, fontweight='bold', y=0.98)

# axes[0,0], axes[0,1], axes[1,0], axes[1,1] — draw each independently
axes[0, 0].bar(...)
axes[0, 1].plot(...)
axes[1, 0].pie(...)
axes[1, 1].barh(...)

plt.tight_layout(rect=[0, 0, 1, 0.96])  # leave room for suptitle
```

---

## Styling best practices

### Professional look

```python
# Use a clean style base
plt.style.use('seaborn-v0_8-whitegrid')  # or 'ggplot', 'fivethirtyeight'

# Color palettes
BLUE_PALETTE = ['#1565C0', '#1976D2', '#42A5F5', '#90CAF9', '#E3F2FD']
CATEGORICAL = ['#2196F3', '#4CAF50', '#FF9800', '#9C27B0', '#F44336', '#00BCD4']

# Consistent font sizes
TITLE_SIZE = 16
LABEL_SIZE = 12
TICK_SIZE = 10

# Remove top and right spines for cleaner look
ax.spines['top'].set_visible(False)
ax.spines['right'].set_visible(False)
```

### Formatting axes

```python
import matplotlib.ticker as mticker

# Currency
ax.yaxis.set_major_formatter(mticker.FuncFormatter(lambda x, _: f'${x:,.0f}'))

# Percentage
ax.yaxis.set_major_formatter(mticker.PercentFormatter(xmax=1, decimals=0))

# Thousands
ax.yaxis.set_major_formatter(mticker.FuncFormatter(lambda x, _: f'{x/1000:.0f}K'))

# Rotate x labels
plt.xticks(rotation=45, ha='right')
```

---

## Validation expectations

Execify checks:
- Output file exists under `/workspace/`
- File size > 5KB (a valid rendered chart)
- `SUCCESS:` message printed to stdout

Generated code must call `plt.savefig('/workspace/<outputFile>', ...)` and `print('SUCCESS: ...')` in the final step.

---

## quantity_patterns

### Plotting exactly N data points

When a step has `points: N`, generate exactly N x-values and N y-values.

```python
# WRONG — hardcoded small dataset:
years = [2020, 2021, 2022]
values = [1.1, 1.3, 1.5]

# CORRECT — generate from a range:
import numpy as np
years = list(range(1980, 1980 + N))   # N = data_points from task spec
# or for year-range tasks:
years = list(range(start_year, end_year + 1))
values = [base + i * trend + noise for i, noise in enumerate(np.random.uniform(-0.05, 0.05, len(years)))]

plt.plot(years, values)
```

### Year-range detection

If the task mentions a year range like "1980 to 2023", derive N from the range:

```python
start_year, end_year = 1980, 2023
years = list(range(start_year, end_year + 1))  # 44 data points
```

### Trend line

For line charts with a trend line, add both series to the plot:

```python
import numpy as np
z = np.polyfit(range(len(years)), values, 1)
trend = np.poly1d(z)(range(len(years)))
plt.plot(years, values, label='Observed', color='steelblue')
plt.plot(years, trend, linestyle='--', color='red', label='Trend')
plt.legend()
```

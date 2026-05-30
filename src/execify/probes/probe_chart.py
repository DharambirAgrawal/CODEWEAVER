#!/usr/bin/env python3
# src/execify/probes/probe_chart.py
# Run: python probe_chart.py <path_to_image>
import sys
import json
try:
    from PIL import Image
except ImportError:
    print(json.dumps({"error": "Pillow not installed"}))
    sys.exit(1)

if len(sys.argv) < 2:
    print(json.dumps({"error": "Usage: probe_chart.py <path>"}))
    sys.exit(1)

path = sys.argv[1]
try:
    img = Image.open(path)
    print(json.dumps({
        "width": img.size[0],
        "height": img.size[1],
        "mode": img.mode,
        "format": img.format,
    }))
except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(1)

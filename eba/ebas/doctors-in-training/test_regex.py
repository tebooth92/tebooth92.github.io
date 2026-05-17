import os
import re

TARGET_DIR = r"c:\Users\teboo\OneDrive\Desktop\Basic Claude Code\1. EBA Wiki\wiki\docs\ebas\doctors-in-training"

def build_clause_map(target_dir):
    clause_map = {}
    for root, dirs, files in os.walk(target_dir):
        for f in files:
            if f.endswith('.md') and f != 'index.md':
                # File names usually start with the clause number, e.g. "35-rosters.md"
                # Some are "10A-consultation...", etc.
                match = re.match(r'^(\d+[A-Z]*)-', f)
                if match:
                    clause_num = match.group(1)
                    rel_path = os.path.relpath(os.path.join(root, f), target_dir)
                    clause_map[clause_num] = rel_path.replace('\\', '/')
    return clause_map

clause_map = build_clause_map(TARGET_DIR)
for k, v in list(clause_map.items())[:5]:
    print(f"{k}: {v}")


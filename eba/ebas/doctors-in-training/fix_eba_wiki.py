import os
import re

TARGET_DIR = r"c:\Users\teboo\OneDrive\Desktop\Basic Claude Code\1. EBA Wiki\wiki\docs\ebas\doctors-in-training"

flags = []
files_touched = 0
fixes_applied = {
    'page_break_orphans': 0,
    'heading_body_collisions': 0,
    'heading_body_glued': 0,
    'legacy_bold_inline': 0,
    'admonitions_added': 0,
    'blank_lines_in_admonitions': 0,
    'admonition_overcapture': 0,
    'acts_italicised': 0,
    'cross_clause_refs': 0,
    'page_header_bleeds': 0,
    'demoted_letters': 0,
    'nominal_expiry_fixed': 0,
    'filename_truncation': 0,
    'multi_space_artifacts': 0,
    'em_dashes': 0
}

def build_clause_map():
    clause_map = {}
    for root, dirs, files in os.walk(TARGET_DIR):
        for f in files:
            if f.endswith('.md') and f != 'index.md':
                match = re.match(r'^(\d+[A-Z]*)-', f)
                if match:
                    clause_num = match.group(1)
                    rel_path = os.path.relpath(os.path.join(root, f), TARGET_DIR)
                    clause_map[clause_num] = rel_path.replace('\\', '/')
    return clause_map

clause_map = build_clause_map()

def process_file(filepath):
    global files_touched, fixes_applied, flags
    
    with open(filepath, 'r', encoding='utf-8') as f:
        original_content = f.read()
        
    content = original_content
    rel_filepath = os.path.relpath(filepath, TARGET_DIR).replace('\\', '/')
    
    # 13. Filename truncation
    filename = os.path.basename(filepath)
    if filename.endswith('-.md') or filename.endswith('-and.md') or filename.endswith('-or.md'):
        flags.append(f"Filename truncation suspected: {rel_filepath}")
        fixes_applied['filename_truncation'] += 1

    is_appendix = 'appendices/' in rel_filepath

    # 12. Frontmatter nominal_expiry
    if not re.search(r'^nominal_expiry:\s*".*?"', content, re.MULTILINE):
        if '---' in content:
            content = re.sub(r'(---\n.*?\n)(---)', r'\1nominal_expiry: "2026-02-28"\n\2', content, count=1, flags=re.DOTALL)
            fixes_applied['nominal_expiry_fixed'] += 1
    else:
        new_content = re.sub(r'^nominal_expiry:\s*".*?"', 'nominal_expiry: "2026-02-28"', content, flags=re.MULTILINE)
        if new_content != content:
            content = new_content
            fixes_applied['nominal_expiry_fixed'] += 1

    # 15. Em dashes
    new_content = content.replace('—', '-').replace('–', '-')
    if new_content != content:
        fixes_applied['em_dashes'] += 1
        content = new_content

    # 14. Multi-space artifacts
    def fix_spaces(match):
        return ' '
    new_content, count = re.subn(r'(?<=\S)[ \t]{2,}(?=\S)', fix_spaces, content)
    if count > 0:
        fixes_applied['multi_space_artifacts'] += count
        content = new_content

    # 8. Cited Acts not italicised
    def fix_acts(match):
        return f"*{match.group(1)}*"
    new_content, count = re.subn(r'(?<!\*)([A-Z][a-zA-Z]+ (?:\w+ )*Act \d{4})(?!\*)', fix_acts, content)
    if count > 0:
        fixes_applied['acts_italicised'] += count
        content = new_content

    # 9. Bare cross-clause references
    def fix_refs(match):
        prefix = match.group(1) 
        clause_ref = match.group(2) 
        base_clause = clause_ref.split('.')[0]
        if base_clause in clause_map:
            target_rel = clause_map[base_clause]
            current_dir = os.path.dirname(rel_filepath)
            if current_dir == '':
                path = target_rel
            else:
                path = os.path.relpath(target_rel, current_dir).replace('\\', '/')
            return f"[{prefix}{clause_ref}]({path})"
        return match.group(0)

    new_content, count = re.subn(r'(?<!\[)\b((?:clause|subclause)s?\s+)(\d+[A-Z]?(?:\.\d+)?)\b', fix_refs, content, flags=re.IGNORECASE)
    if count > 0:
        fixes_applied['cross_clause_refs'] += count
        content = new_content

    lines = content.split('\n')
    new_lines = []
    i = 0
    in_admonition = False
    
    while i < len(lines):
        line = lines[i]
        
        if in_admonition:
            if line.strip() == "":
                fixes_applied['blank_lines_in_admonitions'] += 1
                i += 1
                continue
            elif re.match(r'^\s*\*\*[a-zivx]+\)\*\*', line) or re.match(r'^\s*\([a-zivx]+\)', line) or re.match(r'^\s*###', line) or re.match(r'^<div', line) or line.startswith('---') or re.match(r'^\s*\*\*\d+[A-Z]*\.\d+[A-Z]?\*\*', line):
                in_admonition = False
                if line.startswith('    ') or line.startswith('\t'):
                    line = line.lstrip()
                    fixes_applied['admonition_overcapture'] += 1
            else:
                new_lines.append(f"    {line.lstrip()}")
                i += 1
                continue

        if line.startswith('!!! '):
            new_lines.append(line)
            in_admonition = True
            i += 1
            continue

        note_match = re.match(r'^(NOTE\s*\d*:|Note\s*\d*:|Example\s*\d*:)\s*(.*)', line, re.IGNORECASE)
        if note_match and not is_appendix:
            prefix = note_match.group(1).lower()
            body = note_match.group(2)
            
            if 'example' in prefix:
                new_lines.append('!!! example "Example"')
            else:
                new_lines.append('!!! note')
            
            if body.strip():
                new_lines.append(f"    {body}")
                
            fixes_applied['admonitions_added'] += 1
            in_admonition = True
            i += 1
            continue

        if i < len(lines) - 2 and line.strip() != "" and lines[i+1].strip() == "" and lines[i+2].strip() != "":
            if not re.search(r'[.:?!"*\'\]>]$', line.strip()) and not line.startswith('###') and not line.startswith('---'):
                if re.match(r'^[a-z]', lines[i+2].strip()):
                    new_lines.append(line)
                    i += 1
                    fixes_applied['page_break_orphans'] += 1
                    continue
        
        match = re.match(r'^(\s*)\*\*(\d+[A-Z]*\.\d+[A-Z]?)\*\*\s+(.*)', line)
        if match:
            indent = match.group(1)
            clause_num = match.group(2)
            body = match.group(3)
            new_lines.append(f"{indent}### {clause_num}")
            new_lines.append("")
            new_lines.append(f"{indent}{body}")
            fixes_applied['legacy_bold_inline'] += 1
            i += 1
            continue
            
        if line.startswith('### ') and i < len(lines) - 2 and lines[i+1].strip() == "":
            body_line = lines[i+2]
            collision_match = re.match(r'^([A-Z][a-zA-Z\s]+?)\s+([A-Z].*)', body_line)
            if collision_match and not body_line.startswith('**'):
                title = collision_match.group(1)
                body = collision_match.group(2)
                if len(title.split()) <= 6:
                    new_lines.append(f"{line} {title.strip()}")
                    new_lines.append("")
                    new_lines.append(body)
                    fixes_applied['heading_body_collisions'] += 1
                    i += 3
                    continue
                    
        glued_match = re.match(r'^(### \d+\.\w+) ([A-Z][a-zA-Z\s]+?)\s+([A-Z][a-z].*)', line)
        if glued_match:
            heading_num = glued_match.group(1)
            title = glued_match.group(2)
            body = glued_match.group(3)
            if len(title.split()) <= 6:
                new_lines.append(f"{heading_num} {title.strip()}")
                new_lines.append("")
                new_lines.append(body)
                fixes_applied['heading_body_glued'] += 1
                i += 1
                continue

        bleed_candidates = ['Rosters', 'Recall to Duty', 'Annual leave', 'Personal Leave', 'Consultation', 'Dispute Resolution', 'Definitions', 'Higher Duties', 'Leave']
        if line.strip() in bleed_candidates:
            flags.append(f"Page-header bleed suspected: '{line.strip()}' at {rel_filepath}:{i+1}")
            fixes_applied['page_header_bleeds'] += 1
            
        if not is_appendix:
            if re.search(r'[a-z]\s+[A-Z]\.\s+[A-Z]', line):
                flags.append(f"Demoted-letter sub-points inline suspected at {rel_filepath}:{i+1}")
                fixes_applied['demoted_letters'] += 1

        new_lines.append(line)
        i += 1
        
    content = '\n'.join(new_lines)
    
    if content != original_content:
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(content)
        files_touched += 1

def main():
    for root, dirs, files in os.walk(TARGET_DIR):
        for f in files:
            if f.endswith('.md'):
                process_file(os.path.join(root, f))
                
    report_path = os.path.join(TARGET_DIR, "run_report.txt")
    with open(report_path, 'w', encoding='utf-8') as f:
        f.write("=== EBA WIKI FORMATTING SCRIPT REPORT ===\n\n")
        f.write(f"Files touched: {files_touched}\n\n")
        f.write("Fixes Applied Summary:\n")
        for k, v in fixes_applied.items():
            f.write(f"  {k}: {v}\n")
            
        f.write("\n=== MANUAL REVIEW FLAGS ===\n")
        for flag in flags:
            f.write(flag + "\n")
            
    print(f"Script complete. Report saved to {report_path}")

if __name__ == '__main__':
    main()

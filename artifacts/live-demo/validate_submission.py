from pathlib import Path
import re
text=(Path(__file__).parents[2]/'docs/rhc/hackquest-form-fields.md').read_text(encoding='utf-8')
submission=text.split('## 2. Submission')[1].split('## 3.')[0]
fence=chr(96)*3
blocks=re.findall(fence+'text\n(.*?)\n'+fence,submission,re.S)
assert len(blocks)==5, f'Expected five text fields, found {len(blocks)}'
for block in blocks:
    assert len(block)<=300, (len(block),block)
    print(f'{len(block)}/300: {block.splitlines()[0]}')

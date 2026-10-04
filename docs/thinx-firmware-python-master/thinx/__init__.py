from pathlib import Path
## print(Path) # to check failing import (was causes by incorrect runtime version - the old 2.7)

## Standalone boilerplate before relative imports
if __package__ is None:
    DIR = Path(__file__).resolve().parent
    sys.path.insert(0, str(DIR.parent))
    __package__ = DIR.name

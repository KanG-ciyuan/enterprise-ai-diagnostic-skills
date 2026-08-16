import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
GUARD = ROOT / "scripts/validate_personal_skill_ownership.py"


class PersonalOwnershipGuardTest(unittest.TestCase):
    def test_installable_skill_packages_are_personal_only(self):
        spec = importlib.util.spec_from_file_location("personal_ownership", GUARD)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertEqual([], module.validate(ROOT))


if __name__ == "__main__":
    unittest.main()

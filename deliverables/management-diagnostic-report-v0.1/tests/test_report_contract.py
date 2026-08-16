from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class ReportContractTest(unittest.TestCase):
    def read_html(self):
        path = ROOT / "index.html"
        self.assertTrue(path.is_file(), "index.html")
        return path.read_text(encoding="utf-8")

    def test_required_content_files_exist(self):
        for name in ("index.html", "report-data.js"):
            self.assertTrue((ROOT / name).is_file(), name)

    def test_required_sections_and_boundaries_are_visible(self):
        html = self.read_html()
        self.assertNotIn("document-type", html)
        for section_id in (
            "summary",
            "current-flow",
            "risks",
            "responsibility",
            "target-flow",
            "pilot",
            "evidence-gaps",
        ):
            self.assertIn(f'id="{section_id}"', html)
        for phrase in (
            "补充真实调研后再判断",
            "5天离线影子验证",
            "E5模拟诊断",
            "不连接或修改生产CRM",
        ):
            self.assertIn(phrase, html.replace(" ", ""))

    def test_forbidden_product_claims_are_absent(self):
        content = "\n".join(
            path.read_text(encoding="utf-8") for path in ROOT.glob("*.html")
        )
        for phrase in ("已接入生产CRM", "自动裁决客户归属", "收益已经验证"):
            self.assertNotIn(phrase, content)

    def test_static_assets_are_linked(self):
        html = self.read_html()
        self.assertIn('href="styles.css"', html)
        self.assertIn('src="report-data.js"', html)
        self.assertIn('src="app.js"', html)
        self.assertTrue((ROOT / "styles.css").is_file())

    def test_accessible_interaction_contract(self):
        html = self.read_html()
        script_path = ROOT / "app.js"
        self.assertTrue(script_path.is_file(), "app.js")
        script = script_path.read_text(encoding="utf-8")
        self.assertIn("aria-selected", html)
        self.assertIn("<details", html)
        self.assertIn("window.print", script)
        self.assertIn("scrollIntoView", script)
        self.assertNotIn("panel?.focus", script)
        self.assertNotIn("innerHTML", script)
        for phrase in ("谁来做", "做什么", "产出什么", "暂停条件"):
            self.assertIn(phrase, html)


if __name__ == "__main__":
    unittest.main()

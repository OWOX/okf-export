"""Tiny self-check for engine pure helpers. Run from repo root: python3 -m backend.test_engine"""
from backend import engine as e


def demo():
    # API key parsing
    import base64, json
    payload = base64.urlsafe_b64encode(
        json.dumps({"apiOrigin": "https://x.owox.com/", "apiKeyId": "k", "apiKeySecret": "s"}).encode()
    ).decode().rstrip("=")
    assert e.parse_api_key("owox_key_" + payload) == ("https://x.owox.com", "k", "s")
    try:
        e.parse_api_key("nope")
        assert False, "expected ValueError"
    except ValueError:
        pass

    # slug + yaml escaping
    assert e.slugify("My Mart! (v2)", "fb") == "my-mart-v2"
    assert e.slugify("", "fb") == "fb"
    assert e.yaml_scalar('a "b"\nc') == '"a \\"b\\" c"'

    # repo splitting
    assert e._parse_repo("o/r") == ("o/r", "")
    assert e._parse_repo("o/r/a/b") == ("o/r", "a/b")

    # column extraction tolerates shapes
    cols = e.extract_columns({"fields": [{"name": "x", "type": "STRING", "description": "d"}]})
    assert cols == [("x", "STRING", "d")]
    assert e.extract_columns(None) == []

    print("ok")


if __name__ == "__main__":
    demo()

import contextlib
import io
import json
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import Mock

import serve


ROSTER = [{"name": "coder", "aliases": ["Rick", "the coder"]}, {"name": "reviewer", "aliases": []}]


def answers(intent="transfer", target="coder", now=0.9, confidence=0.85):
    return {"intent": {"choice": intent, "probabilities": {intent: confidence}},
            "target": {"choice": target}, "request_now": {"noul": now}}


def request(**overrides):
    return json.dumps({"utterance": "ask Rick", "roster": ROSTER, **overrides}).encode()


class FormatTests(unittest.TestCase):
    def test_state_matches_training(self):
        self.assertEqual(serve.state("  ask  Rick\n now\t"), "Operator said: ask Rick now")
        self.assertEqual(serve.state("x" * 2000), "Operator said: " + "x" * 500)

    def test_questions_match_training(self):
        _, roster = serve.parse_request(request())
        self.assertEqual(serve.questions(roster), {
            "intent": {"type": "choice", "instructions":
                "Which switchboard action does the operator want? Interpret meaning, paraphrases and speech "
                "recognition noise. Discussing an action, past or hypothetical mentions are none.", "criteria": {
                    "transfer": "speak with one particular employee now in this conversation",
                    "release": "end the current employee conversation, undo the transfer, return to the main assistant or reception",
                    "rollcall": "gather the employees for introductions, attendance, presence check-ins or a group connection",
                    "standup": "get progress or status updates from the employees as a group",
                    "callme": "place an outgoing call to the operator's phone now, optionally with one employee",
                    "none": "ordinary work, small talk, mentions or questions about actions, unclear speech"}},
            "target": {"type": "choice", "instructions":
                "Which employee should the operator be connected to, or called by? Only for a transfer or a "
                "call-me request; otherwise nobody, even if an employee is mentioned.", "criteria": {
                    "coder": "also called Rick, the coder", "reviewer": "also called reviewer",
                    "nobody": "no particular employee is named or meant"}},
            "request_now": {"type": "noul", "instructions":
                "The operator is requesting this action now (including polite questions and delegation), "
                "not mentioning it in the past, hypothetically, for later, or asking about it."}})
        self.assertEqual(list(serve.INTENT_DESC), serve.INTENTS)

    def test_request_boundaries_accept_maximum_unicode_lengths(self):
        lanes = [{"name": str(i) + "😀" * (128 - len(str(i))), "aliases": ["😀" * 128] * 16}
                 for i in range(32)]
        utterance, roster = serve.parse_request(request(utterance="😀" * 2000, roster=lanes))
        self.assertEqual(len(utterance), 2000)
        self.assertEqual(len(roster), 32)
        self.assertEqual(serve.parse_request(request(utterance="", roster=[])), ("", {}))

    def test_rejects_malformed_request(self):
        for body in (b"[]", b"null", b"{}", b"not json", b"\xff", b"x" * (serve.MAX_BODY_BYTES + 1),
                     request(utterance=3), request(utterance="x" * 2001), request(roster={}),
                     request(roster=[{"name": str(i), "aliases": []} for i in range(33)])):
            with self.subTest(body=body[:40]), self.assertRaises(ValueError):
                serve.parse_request(body)

    def test_rejects_invalid_lanes_without_truncating(self):
        for lane in (None, [], {}, {"name": 3, "aliases": []}, {"name": "", "aliases": []},
                     {"name": "x" * 129, "aliases": []}, {"name": "coder"},
                     {"name": "coder", "aliases": "Rick"}, {"name": "coder", "aliases": [3]},
                     {"name": "coder", "aliases": ["x" * 129]},
                     {"name": "coder", "aliases": ["x"] * 17}, {"name": "nobody", "aliases": []}):
            with self.subTest(lane=lane), self.assertRaises(ValueError):
                serve.parse_request(request(roster=[lane]))
        with self.assertRaises(ValueError):
            serve.parse_request(request(roster=[ROSTER[0], ROSTER[0]]))


class DecodeTests(unittest.TestCase):
    def test_dict_and_attribute_answers(self):
        raw = answers()
        for ans in (raw, {k: SimpleNamespace(**v) for k, v in raw.items()}):
            self.assertEqual(serve.from_answers(ans), {
                "intent": "transfer", "target": "coder", "request_now": True, "confidence": 0.85})

    def test_callme_later_and_strict_noul_threshold(self):
        for now, expected in ((0.1, False), (0.5, False), (0.5001, True)):
            self.assertEqual(serve.from_answers(answers("callme", now=now))["request_now"], expected)

    def test_non_callme_actions_ignore_noul(self):
        for intent in ("transfer", "release", "rollcall", "standup"):
            ans = answers(intent, now=0)
            ans["request_now"] = object()  # the head is never consulted
            out = serve.from_answers(ans)
            self.assertTrue(out["request_now"])
            self.assertEqual(out["target"], "coder" if intent == "transfer" else None)

    def test_nobody_is_null(self):
        self.assertIsNone(serve.from_answers(answers("callme", "nobody"))["target"])

    def test_none_and_transfer_without_target_keep_probability(self):
        for intent, target in (("none", "coder"), ("transfer", "nobody")):
            self.assertEqual(serve.from_answers(answers(intent, target)), {
                "intent": "none", "target": None, "request_now": False, "confidence": 0.85})

    def test_invalid_model_values_fail_closed(self):
        for ans in ({}, answers("unknown"), answers(confidence=float("nan")),
                    answers(confidence=float("inf")), answers(confidence=-1), answers(confidence=1.1),
                    answers(target=1), answers(target="x" * 129)):
            with self.subTest(ans=ans), self.assertRaises((ValueError, KeyError)):
                serve.from_answers(ans)

    def test_model_api_uses_training_token_limits(self):
        model = serve.LayaModel.__new__(serve.LayaModel)
        model.lock = threading.Lock()
        model.agent = SimpleNamespace(system_one=Mock(return_value={"answers": answers()}))
        q = serve.questions({})
        self.assertEqual(model.score("Operator said: hi", q), answers())
        model.agent.system_one.assert_called_once_with("Operator said: hi", q, max_len=512, head_max_len=384)


class DeviceTests(unittest.TestCase):
    PAT = __import__("re").compile(r"^qwen3\.8")

    def test_cpu_while_qwen_loaded_or_starting(self):
        for state in ("ready", "starting"):
            with self.subTest(state=state):
                body = {"running": [{"model": "qwen3.8-27b-heretic", "state": state}]}
                self.assertEqual(serve.desired_device(body, self.PAT), "cpu")

    def test_gpu_otherwise(self):
        self.assertEqual(serve.desired_device({"running": []}, self.PAT), "cuda")
        self.assertEqual(serve.desired_device({"running": [{"model": "gemma4-a4b-qat", "state": "ready"}]}, self.PAT), "cuda")
        self.assertEqual(serve.desired_device({"running": [{"model": "qwen3.8-27b-heretic", "state": "stopping"}]}, self.PAT), "cuda")

    def test_unknown_body_leaves_device_alone(self):
        for body in (None, [], {"running": "x"}, {}):
            with self.subTest(body=body):
                self.assertIsNone(serve.desired_device(body, self.PAT))


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.seen = []
        self.result = answers()
        self.error = None

        def score(state, questions):
            self.seen.append((state, questions))
            if self.error:
                raise self.error
            return self.result

        self.handler = serve.make_handler(score, "fake", lambda: "cpu")

    def exchange(self, body=b"", path="/v1/switchboard", method="POST", headers=None):
        # Run BaseHTTPRequestHandler's real parser/dispatcher over injected I/O.
        # No live sockets: this suite must also run in an offline sandbox.
        fields = {"Content-Length": str(len(body)), **(headers or {})}
        wire = f"{method} {path} HTTP/1.0\r\n".encode()
        wire += "".join(f"{k}: {v}\r\n" for k, v in fields.items()).encode() + b"\r\n" + body
        output = io.BytesIO()
        connection = SimpleNamespace(settimeout=lambda _: None, makefile=lambda *_: io.BytesIO(wire),
                                     sendall=output.write)
        self.handler(connection, ("127.0.0.1", 12345), SimpleNamespace())
        head, payload = output.getvalue().split(b"\r\n\r\n", 1)
        status = int(head.split(b" ", 2)[1])
        return status, json.loads(payload)

    def test_switchboard_round_trip_exact_shape(self):
        status, result = self.exchange(request(utterance="  ask Rick  "))
        self.assertEqual(status, 200)
        self.assertEqual(result, {"intent": "transfer", "target": "coder",
                                  "request_now": True, "confidence": 0.85})
        self.assertEqual(self.seen, [("Operator said: ask Rick", serve.questions({
            "coder": {"aliases": ["Rick", "the coder"]}, "reviewer": {"aliases": []}}))])

    def test_bad_request_is_400_and_not_scored(self):
        for body in (request(utterance=1), request(utterance="x" * 2001), request(roster=[None]),
                     b"\xff", b"[" * 2000):
            self.assertEqual(self.exchange(body)[0], 400)
        self.assertEqual(self.seen, [])

    def test_bad_body_length_is_400(self):
        for length in ("-1", "invalid", str(serve.MAX_BODY_BYTES + 1)):
            self.assertEqual(self.exchange(headers={"Content-Length": length})[0], 400)
        self.assertEqual(self.seen, [])

    def test_incomplete_body_is_400(self):
        self.assertEqual(self.exchange(b"{}", headers={"Content-Length": "100"})[0], 400)
        self.assertEqual(self.seen, [])

    def test_unknown_routes_are_404(self):
        for method in ("GET", "POST"):
            self.assertEqual(self.exchange(path="/v1/judge", method=method)[0], 404)
        self.assertEqual(self.seen, [])

    def test_health(self):
        self.assertEqual(self.exchange(path="/health", method="GET"),
                         (200, {"ok": True, "model": "fake", "device": "cpu"}))

    def test_invalid_answers_are_500(self):
        self.result = answers(confidence=float("nan"))
        self.assertEqual(self.exchange(request()), (500, {"error": "classification failed"}))

    def test_never_logs_or_echoes_transcripts(self):
        secret = "synthetic-private-utterance"
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            self.assertEqual(self.exchange(request(utterance=secret))[0], 200)
            self.error = ValueError(secret)
            self.assertEqual(self.exchange(request(utterance=secret)),
                             (500, {"error": "classification failed"}))
        self.assertEqual(output.getvalue(), "")


if __name__ == "__main__":
    unittest.main()

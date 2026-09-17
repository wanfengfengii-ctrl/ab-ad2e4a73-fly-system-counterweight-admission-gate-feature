"""配重片转移的真实 HTTP + 真实 PostgreSQL 端到端验收。"""

import threading
from concurrent.futures import ThreadPoolExecutor

import httpx


def load_piece(base_url, batten_id, piece_id, weight_grams):
    resp = httpx.post(
        f"{base_url}/api/battens/{batten_id}/loads",
        json={"piece_id": piece_id, "weight_grams": weight_grams},
        timeout=30,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def transfer_piece(base_url, source_id, piece_id, target_id):
    return httpx.post(
        f"{base_url}/api/battens/{source_id}/transfers",
        json={"piece_id": piece_id, "target_batten_id": target_id},
        timeout=30,
    )


def batten_state(base_url, batten_id):
    resp = httpx.get(f"{base_url}/api/battens/{batten_id}", timeout=10)
    assert resp.status_code == 200
    return resp.json()


def find_load(state, piece_id):
    return next(l for l in state["loads"] if l["piece_id"] == piece_id)


def test_successful_transfer_updates_both_battens_and_keeps_identity(base_url):
    load_piece(base_url, "G-01", "CW-MOVE", 15000)
    before = batten_state(base_url, "G-01")
    original = find_load(before, "CW-MOVE")

    resp = transfer_piece(base_url, "G-01", "CW-MOVE", "G-02")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["accepted"] is True
    # 响应明确给出配重片去向
    assert body["source_batten_id"] == "G-01"
    assert body["target_batten_id"] == "G-02"
    assert "G-01" in body["message"] and "G-02" in body["message"]
    # 只改归属：load_id、原始重量、登记时间全部保留
    assert body["load"]["load_id"] == original["load_id"]
    assert body["load"]["weight_grams"] == 15000
    assert body["load"]["created_at"] == original["created_at"]
    # 响应内的两杆快照
    assert body["source"]["total_grams"] == 0
    assert body["source"]["remaining_grams"] == 30000
    assert body["target"]["total_grams"] == 15000
    assert body["target"]["remaining_grams"] == 35000

    source = batten_state(base_url, "G-01")
    target = batten_state(base_url, "G-02")
    assert source["total_grams"] == 0
    assert source["remaining_grams"] == 30000
    assert source["loads"] == []
    assert target["total_grams"] == 15000
    assert target["remaining_grams"] == 35000
    moved = find_load(target, "CW-MOVE")
    assert moved["load_id"] == original["load_id"]
    assert moved["weight_grams"] == 15000
    assert moved["created_at"] == original["created_at"]


def test_insufficient_target_capacity_leaves_ownership_unchanged(base_url):
    load_piece(base_url, "G-01", "CW-BIG", 20000)
    load_piece(base_url, "G-02", "CW-KEEP-1", 20000)
    load_piece(base_url, "G-02", "CW-KEEP-2", 20000)

    resp = transfer_piece(base_url, "G-01", "CW-BIG", "G-02")
    assert resp.status_code == 409
    body = resp.json()
    assert body["accepted"] is False
    assert body["reason"] == "OVER_CAPACITY"

    # 数据库保持原归属：源杆仍是 20000，目标仍是 40000
    source = batten_state(base_url, "G-01")
    target = batten_state(base_url, "G-02")
    assert source["total_grams"] == 20000
    assert source["remaining_grams"] == 10000
    assert [l["piece_id"] for l in source["loads"]] == ["CW-BIG"]
    assert target["total_grams"] == 40000
    assert target["remaining_grams"] == 10000
    assert [l["piece_id"] for l in target["loads"]] == [
        "CW-KEEP-1",
        "CW-KEEP-2",
    ]


def test_concurrent_opposite_transfers_both_succeed_without_deadlock(base_url):
    """G-01↔G-02 各移一片 10000 克：两笔都应成功，两杆均不超限。"""
    load_piece(base_url, "G-01", "CW-A", 10000)
    load_piece(base_url, "G-02", "CW-C", 10000)
    barrier = threading.Barrier(2)

    def submit(direction):
        barrier.wait(timeout=10)
        if direction == "a":
            return transfer_piece(base_url, "G-01", "CW-A", "G-02")
        return transfer_piece(base_url, "G-02", "CW-C", "G-01")

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(submit, ["a", "c"]))

    # 固定顺序加锁：不得出现死锁导致的 5xx，两笔都成功
    assert sorted(r.status_code for r in responses) == [200, 200], [
        r.text for r in responses
    ]

    g01 = batten_state(base_url, "G-01")
    g02 = batten_state(base_url, "G-02")
    assert g01["total_grams"] == 10000
    assert g02["total_grams"] == 10000
    assert [l["piece_id"] for l in g01["loads"]] == ["CW-C"]
    assert [l["piece_id"] for l in g02["loads"]] == ["CW-A"]


def test_concurrent_opposite_transfers_never_exceed_capacity(base_url):
    """贴近容量上限的反向并发：无论裁决顺序如何，两杆最终都不得超限。"""
    load_piece(base_url, "G-01", "CW-A", 20000)  # 源杆剩余 10000
    load_piece(base_url, "G-02", "CW-C", 20000)
    barrier = threading.Barrier(2)

    def submit(direction):
        barrier.wait(timeout=10)
        if direction == "a":
            # A 到 G-02：20000 + 20000 = 40000，允许
            return transfer_piece(base_url, "G-01", "CW-A", "G-02")
        # C 到 G-01：若 A 尚未移走则 40000 > 30000，必须拒绝
        return transfer_piece(base_url, "G-02", "CW-C", "G-01")

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(submit, ["a", "c"]))

    statuses = sorted(r.status_code for r in responses)
    assert statuses in ([200, 200], [200, 409]), statuses
    for resp in responses:
        if resp.status_code == 409:
            assert resp.json()["reason"] == "OVER_CAPACITY"

    g01 = batten_state(base_url, "G-01")
    g02 = batten_state(base_url, "G-02")
    assert g01["total_grams"] <= g01["capacity_grams"]
    assert g02["total_grams"] <= g02["capacity_grams"]
    # 转移只改归属：两片配重片始终都在，总重量守恒
    assert g01["total_grams"] + g02["total_grams"] == 40000


def test_piece_moved_elsewhere_is_reported(base_url):
    load_piece(base_url, "G-01", "CW-AWAY", 5000)
    # 另一终端先把片子移到 G-02
    first = transfer_piece(base_url, "G-01", "CW-AWAY", "G-02")
    assert first.status_code == 200

    # 仍按旧位置发起转移：必须明确告知当前位置已变化，且不重复移动
    resp = transfer_piece(base_url, "G-01", "CW-AWAY", "G-02")
    assert resp.status_code == 409
    body = resp.json()
    assert body["accepted"] is False
    assert body["reason"] == "PIECE_MOVED"
    assert "当前位置已变化" in body["message"]
    assert body["current_batten_id"] == "G-02"

    assert find_load(batten_state(base_url, "G-02"), "CW-AWAY") is not None
    assert batten_state(base_url, "G-01")["loads"] == []


def test_same_target_and_source_is_rejected(base_url):
    load_piece(base_url, "G-01", "CW-SELF", 1000)
    resp = transfer_piece(base_url, "G-01", "CW-SELF", "G-01")
    assert resp.status_code == 422
    body = resp.json()
    assert body["accepted"] is False
    assert body["reason"] == "SAME_BATTEN"

    state = batten_state(base_url, "G-01")
    assert [l["piece_id"] for l in state["loads"]] == ["CW-SELF"]


def test_unknown_target_batten_is_rejected(base_url):
    load_piece(base_url, "G-01", "CW-GO", 1000)
    resp = transfer_piece(base_url, "G-01", "CW-GO", "G-99")
    assert resp.status_code == 404
    assert resp.json()["reason"] == "BATTEN_NOT_FOUND"
    # 归属不变
    assert [l["piece_id"] for l in batten_state(base_url, "G-01")["loads"]] == [
        "CW-GO"
    ]


def test_unregistered_piece_is_rejected(base_url):
    resp = transfer_piece(base_url, "G-01", "CW-NEVER", "G-02")
    assert resp.status_code == 404
    body = resp.json()
    assert body["accepted"] is False
    assert body["reason"] == "PIECE_NOT_FOUND"


def test_malformed_transfer_body_is_rejected(base_url):
    resp = httpx.post(
        f"{base_url}/api/battens/G-01/transfers",
        json={"piece_id": "CW-X"},
        timeout=10,
    )
    assert resp.status_code == 422
    assert resp.json()["reason"] == "INVALID_INPUT"

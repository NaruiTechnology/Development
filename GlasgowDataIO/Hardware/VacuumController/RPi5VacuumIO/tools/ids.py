import uuid
NS = uuid.UUID("6e2f8e0c-0000-4000-8000-000000000000")
def U(*k): return str(uuid.uuid5(NS, "/".join(map(str, k))))
ROOT = U("root")

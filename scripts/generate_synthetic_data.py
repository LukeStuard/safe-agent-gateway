"""Generate synthetic Contact and Application records for the Safe Agent Gateway project.

All data is fictional. Emails use the reserved example.com domain (RFC 2606).
The random seed is fixed so the output is reproducible.

Usage:
    python scripts/generate_synthetic_data.py
Outputs:
    data/contacts.csv
    data/applications.csv
"""
import csv
import random
from datetime import date, timedelta
from pathlib import Path

SEED = 42
NUM_CONTACTS = 200

FIRST_NAMES = [
    "Avery", "Jordan", "Riley", "Casey", "Morgan", "Taylor", "Quinn", "Rowan", "Skyler", "Emerson",
    "Harper", "Kai", "Reese", "Sage", "Parker", "Dakota", "Finley", "Hayden", "Jules", "Marlowe",
    "Noa", "Remy", "Sol", "Tatum", "Wren", "Ari", "Blair", "Cruz", "Devon", "Ellis",
]
LAST_NAMES = [
    "Alvarez", "Brennan", "Castillo", "Delgado", "Ellison", "Fujimoto", "Garrison", "Hollis", "Ibarra", "Jensen",
    "Kowalski", "Lindqvist", "Moreau", "Nakamura", "Okafor", "Petrov", "Quintero", "Rasmussen", "Sorensen", "Tran",
    "Uribe", "Valdez", "Whitaker", "Xiong", "Yamada", "Zielinski", "Abernathy", "Bautista", "Chandra", "Dumont",
]
TERMS = ["Fall 2026", "Spring 2027", "Summer 2027", "Fall 2027"]
PROGRAMS = ["MBA", "MS Management", "MS Data Analytics", "Certificate in Leadership"]
STATUSES = ["Draft", "Submitted", "In Review", "Admitted", "Denied", "Enrolled", "Withdrawn"]
STATUS_WEIGHTS = [10, 20, 20, 20, 10, 15, 5]
REVIEW_NOTES = [
    "Strong professional background; recommend interview.",
    "Transcripts received. Awaiting second letter of recommendation.",
    "Applicant requested a term deferral.",
    "Essay is thoughtful and well organized.",
    "Missing English proficiency documentation.",
    "Reviewed by committee; meets all admission criteria.",
    "",
]


def random_date(rng, start, end):
    return start + timedelta(days=rng.randint(0, (end - start).days))


def main():
    rng = random.Random(SEED)
    out_dir = Path(__file__).resolve().parent.parent / "data"
    out_dir.mkdir(exist_ok=True)

    contacts = []
    used_ids = set()
    for i in range(NUM_CONTACTS):
        first = rng.choice(FIRST_NAMES)
        last = rng.choice(LAST_NAMES)
        while True:
            student_id = f"S{rng.randint(1000000, 9999999)}"
            if student_id not in used_ids:
                used_ids.add(student_id)
                break
        contacts.append({
            "FirstName": first,
            "LastName": last,
            "Email": f"{first.lower()}.{last.lower()}.{i:03d}@example.com",
            "Birthdate": random_date(rng, date(1975, 1, 1), date(2004, 12, 31)).isoformat(),
            "Student_ID__c": student_id,
        })

    applications = []
    for c in contacts:
        # Most applicants have one application; some have two (reapplications)
        for _ in range(1 if rng.random() < 0.85 else 2):
            status = rng.choices(STATUSES, weights=STATUS_WEIGHTS)[0]
            submitted = "" if status == "Draft" else random_date(rng, date(2026, 1, 5), date(2026, 10, 15)).isoformat()
            applications.append({
                "Applicant__r.Student_ID__c": c["Student_ID__c"],
                "Status__c": status,
                "Term__c": rng.choice(TERMS),
                "Program__c": rng.choice(PROGRAMS),
                "Submitted_Date__c": submitted,
                "Review_Notes__c": rng.choice(REVIEW_NOTES) if status not in ("Draft", "Submitted") else "",
            })

    for name, rows in (("contacts.csv", contacts), ("applications.csv", applications)):
        with open(out_dir / name, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()), lineterminator="\n")
            writer.writeheader()
            writer.writerows(rows)
        print(f"Wrote {len(rows)} rows to data/{name}")


if __name__ == "__main__":
    main()

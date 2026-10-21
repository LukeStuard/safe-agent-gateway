// Links synthetic Contacts to a parent Account so they are shareable.
// Contacts with no Account are private to their owner regardless of sharing settings.
// Safe to rerun: reuses the Account and only updates unlinked Contacts.
List<Account> existing = [SELECT Id FROM Account WHERE Name = 'Synthetic Applicants' LIMIT 1];
Account acct = existing.isEmpty() ? new Account(Name = 'Synthetic Applicants') : existing[0];
if (acct.Id == null) {
    insert acct;
}
List<Contact> contacts = [SELECT Id FROM Contact WHERE Student_ID__c != null AND AccountId = null];
for (Contact c : contacts) {
    c.AccountId = acct.Id;
}
update contacts;
System.debug('Linked ' + contacts.size() + ' contacts to Account ' + acct.Id);

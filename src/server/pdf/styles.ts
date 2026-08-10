import { StyleSheet } from '@react-pdf/renderer'

export const styles = StyleSheet.create({
  page: { padding: 36, fontSize: 10, fontFamily: 'Helvetica', color: '#0f172a' },
  header: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 24 },
  orgName: { fontSize: 16, fontFamily: 'Helvetica-Bold' },
  docTitle: { fontSize: 14, fontFamily: 'Helvetica-Bold', textAlign: 'right' },
  muted: { color: '#64748b' },
  section: { marginBottom: 16 },
  label: { color: '#64748b', marginBottom: 2 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  tableHeader: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#cbd5e1',
    paddingBottom: 4,
    marginBottom: 4,
    fontFamily: 'Helvetica-Bold'
  },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 3,
    borderBottomWidth: 0.5,
    borderBottomColor: '#e2e8f0'
  },
  colSeq: { width: '10%' },
  colDate: { width: '25%' },
  colAmount: { width: '25%', textAlign: 'right' },
  colPaid: { width: '20%', textAlign: 'right' },
  colStatus: { width: '20%', textAlign: 'right' },
  total: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10, fontFamily: 'Helvetica-Bold' },
  void: { color: '#b91c1c', fontFamily: 'Helvetica-Bold', marginTop: 8 },
  footer: { position: 'absolute', bottom: 24, left: 36, right: 36, fontSize: 8, color: '#94a3b8' }
})

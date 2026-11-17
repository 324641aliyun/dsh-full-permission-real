import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attachReview } from '../lib/host.js'

test('denials stay in the tool result; only a newly reviewed invocation can execute', async () => {
  let gate, guard, verdict, reviews=0, verified=true
  const session = {}
  const ctx = {
    permissionPresets:{current:()=>'full-access-real'}, tools:{guard:f=>{guard=f}},
    on:(_,f)=>{gate=f},workingDirectory:{},llm:{},
  }
  const upstream = {apply(adapter) {
    adapter.on('tools/pre-execute',async(exec,next)=>{
      assert.equal(adapter.approval.overrideOf(session),'never')
      reviews++
      return verdict === 'allow' ? next() : {kind:'deny',info:{reason:'Scope too broad'}}
    })
  }}
  attachReview(ctx,upstream,async()=>verified)
  const call = command => ({agent:{session},name:'pwsh',arguments:{command},signal:AbortSignal.timeout(3000)})
  const next = async()=>({kind:'allow'})
  const rejected=call('first')
  assert.match((await gate(rejected,next)).reason,/Scope too broad/)
  assert.ok(guard(rejected))
  assert.equal((await gate(rejected,next)).kind,'deny')
  const revised=call('revised')
  verdict='allow'
  assert.equal((await gate(revised,next)).kind,'allow')
  assert.equal(guard(revised),undefined)
  assert.ok(guard(revised))
  assert.ok(guard(call('revised')))
  assert.equal((await gate(call('another'),async()=>({kind:'ask'}))).kind,'deny')
  verified=false
  assert.match((await gate(call('x'),next)).reason,/no enabled TrustedInstaller/)
  assert.equal(reviews,4)
})

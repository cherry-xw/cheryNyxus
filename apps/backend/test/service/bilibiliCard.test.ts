import {it,expect} from 'vitest'
import {textOf} from '../../../../platform/napcat-plugin/src/adapter.js'
it('extracts allowed Bilibili card URLs and ignores arbitrary cards',()=>{
 const card=(app:string,url:string)=>[{type:'json',data:{data:JSON.stringify({app,meta:{detail_1:{qqdocurl:url}}})}}]
 expect(textOf(card('com.tencent.miniapp_01','https://b23.tv/3v0nga6'))).toBe('\nhttps://b23.tv/3v0nga6')
 expect(textOf(card('other','https://b23.tv/test'))).toBe('')
 expect(textOf(card('com.tencent.structmsg','https://evil.example/video'))).toBe('')
})

import { get } from "svelte/store";
import type { OpenAIChat } from ".";
import { DataBase, type Chat, type character, type groupChat } from "../storage/database";
import { tokenize } from "../tokenizer";
import { findCharacterbyId } from "../util";
import { requestChatData } from "./request";

export async function supaMemory(chats:OpenAIChat[],currentTokens:number,maxContextTokens:number,room:Chat,char:character|groupChat): Promise<{ currentTokens: number; chats: OpenAIChat[]; error?:string; memory?:string;lastId?:string}>{
    const db = get(DataBase)
    console.log("Memory: " + currentTokens)

    if(currentTokens > maxContextTokens){
        let coIndex = -1
        for(let i=0;i<chats.length;i++){
            if(chats[i].memo === 'NewChat'){
                coIndex = i
                break
            }
        }
        if(coIndex !== -1){
            for(let i=0;i<coIndex;i++){
                currentTokens -= (await tokenize(chats[0].content) + 1)
                chats.splice(0, 1)
            }
        }

        let supaMemory = ''
        let lastId = ''

        if(room.supaMemoryData && room.supaMemoryData.length > 4){
            const splited = room.supaMemoryData.split('\n')
            const id = splited.splice(0,1)[0]
            const data = splited.join('\n')

            let i =0;
            while(true){
                if(chats.length === 0){
                    return {
                        currentTokens: currentTokens,
                        chats: chats,
                        error: "SupaMemory: chat ID not found"
                    }
                }
                if(chats[0].memo === id){
                    lastId = id
                    break
                }
                currentTokens -= (await tokenize(chats[0].content) + 1)
                chats.splice(0, 1)
                i += 1
            }

            supaMemory = data
            currentTokens += await tokenize(supaMemory) + 1
        }


        if(currentTokens < maxContextTokens){
            chats.unshift({
                role: "system",
                content: supaMemory
            })
            return {
                currentTokens: currentTokens,
                chats: chats
            }
        }


        async function summarize(stringlizedChat:string){

            const supaPrompt = db.supaMemoryPrompt === '' ?
            "[Summarize the ongoing role story, including as many events from the past as possible, using assistant as a narrative helper;do not analyze. include all of the characters' names, statuses, thoughts, relationships, and attire. Be sure to include dialogue exchanges and context by referencing previous statements and reactions. assistant's summary should provide an objective overview of the story while also considering relevant past conversations and events. It must also remove redundancy and unnecessary content from the prompt so that gpt3 and other sublanguage models]\n"
            : db.supaMemoryPrompt
    
            let result = ''

            if(db.supaMemoryType !== 'subModel'){
                const promptbody = stringlizedChat + '\n\n' + supaPrompt + "\n\nOutput:"

                const da = await fetch("https://api.openai.com/v1/completions",{
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": "Bearer " + db.supaMemoryKey
                    },
                    method: "POST",
                    body: JSON.stringify({
                        "model": db.supaMemoryType === 'curie' ? "text-curie-001" : "text-davinci-003",
                        "prompt": promptbody,
                        "max_tokens": 600,
                        "temperature": 0
                    })
                })
    
                if(da.status < 200 || da.status >= 300){
                    return {
                        currentTokens: currentTokens,
                        chats: chats,
                        error: "SupaMemory: HTTP: " + await da.text()
                    }
                }
                result = (await da.json()).choices[0].text.trim()
            }
            else {
                const promptbody:OpenAIChat[] = [
                    {
                        role: "user",
                        content: stringlizedChat
                    },
                    {
                        role: "system",
                        content: supaPrompt
                    }
                ]
                const da = await requestChatData({
                    formated: promptbody,
                    bias: {}
                }, 'submodel')
                if(da.type === 'fail' || da.type === 'streaming'){
                    return {
                        currentTokens: currentTokens,
                        chats: chats,
                        error: "SupaMemory: HTTP: " + da.result
                    }
                }
                result = da.result
            }
            return result
        }

        while(currentTokens > maxContextTokens){
            const beforeToken = currentTokens
            let maxChunkSize = maxContextTokens > 3500 ? 1200 : Math.floor(maxContextTokens / 3)
            let summarized = false
            let chunkSize = 0
            let stringlizedChat = ''
            let spiceLen = 0
            while(true){
                const cont = chats[spiceLen]
                if(!cont){
                    currentTokens = beforeToken
                    stringlizedChat = ''
                    chunkSize = 0
                    spiceLen = 0
                    if(summarized){
                        if(maxChunkSize < 500){
                            return {
                                currentTokens: currentTokens,
                                chats: chats,
                                error: "Not Enough Tokens"
                            }
                        }
                        maxChunkSize = maxChunkSize * 0.7
                    }
                    else{
                        const result = await summarize(supaMemory)
                        if(typeof(result) !== 'string'){
                            return result
                        }

                        console.log(currentTokens)
                        currentTokens -= await tokenize(supaMemory)
                        currentTokens += await tokenize(result + '\n\n')
                        console.log(currentTokens)

                        supaMemory = result + '\n\n'
                        summarized = true
                        if(currentTokens <= maxContextTokens){
                            break
                        }
                    }
                    continue
                }
                const tokens = await tokenize(cont.content) + 1
                if((chunkSize + tokens) > maxChunkSize){
                    if(stringlizedChat === ''){
                        stringlizedChat += `${cont.role === 'assistant' ? char.type === 'group' ? '' : char.name : db.username}: ${cont.content}\n\n`
                    }
                    lastId = cont.memo
                    break
                }
                stringlizedChat += `${cont.role === 'assistant' ? char.type === 'group' ? '' : char.name : db.username}: ${cont.content}\n\n`
                spiceLen += 1
                currentTokens -= tokens
                chunkSize += tokens
            }
            chats.splice(0, spiceLen)

            if(stringlizedChat !== ''){
                const result = await summarize(stringlizedChat)

                if(typeof(result) !== 'string'){
                    return result
                }
    
                const tokenz = await tokenize(result + '\n\n') + 5
                currentTokens += tokenz
                supaMemory += result.replace(/\n+/g,'\n') + '\n\n'

                let SupaMemoryList = supaMemory.split('\n\n')
                if(SupaMemoryList.length >= 5){
                    const oldSupaMemory = supaMemory
                    let modifies = []
                    for(let i=0;i<3;i++){
                        modifies.push(SupaMemoryList.shift())
                    }
                    const result = await summarize(supaMemory)
                    if(typeof(result) !== 'string'){
                        return result
                    }

                    modifies.unshift(result.replace(/\n+/g,'\n'))
                    supaMemory = modifies.join('\n\n') + '\n\n'

                    currentTokens -= await tokenize(oldSupaMemory)
                    currentTokens += await tokenize(supaMemory)
                }
            }


        }

        chats.unshift({
            role: "system",
            content: supaMemory
        })
        return {
            currentTokens: currentTokens,
            chats: chats,
            memory: lastId + '\n' + supaMemory,
            lastId: lastId
        }

    }
    return {
        currentTokens: currentTokens,
        chats: chats
    }
}


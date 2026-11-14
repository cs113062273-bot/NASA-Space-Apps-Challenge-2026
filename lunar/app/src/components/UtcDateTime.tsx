import {useEffect,useRef,useState} from 'react'
import {fromInputValue,toInputValue} from '../lib/ui'

/** A locale-independent UTC editor: browsers can force AM/PM on native
 * datetime-local inputs even when the page requests a 24-hour locale. */
export function UtcDateTime({label,value,onChange,min,max,snap='round'}:{label:string;value:number;onChange:(v:number)=>void;min?:number;max?:number;snap?:'round'|'floor'}){
  const display=(u:number)=>toInputValue(u).replace('T',' '),[draft,setDraft]=useState(display(value)),[invalid,setInvalid]=useState(false),skipBlur=useRef(false)
  useEffect(()=>{setDraft(display(value));setInvalid(false)},[value])
  const commit=()=>{
    const next=fromInputValue(draft.trim().replace(' ','T'))
    const hour=next===null?null:Math[snap](next/3600)*3600
    if(hour===null||min!==undefined&&hour<min||max!==undefined&&hour>max){setInvalid(true);return}
    setInvalid(false);onChange(hour);setDraft(display(hour))
  }
  return <input className="input mono utc-datetime" type="text" inputMode="text" aria-label={label} aria-invalid={invalid||undefined}
    title={invalid?'Enter a valid UTC date and 24-hour time inside the available date range.':'UTC date and 24-hour time: YYYY-MM-DD HH:mm. Changes apply on Enter or when you leave the field.'}
    placeholder="YYYY-MM-DD HH:mm" value={draft} onChange={e=>{setDraft(e.target.value);setInvalid(false)}} onBlur={()=>{if(skipBlur.current){skipBlur.current=false;return}commit()}}
    onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();commit();skipBlur.current=true;e.currentTarget.blur()}if(e.key==='Escape'){setDraft(display(value));setInvalid(false);skipBlur.current=true;e.currentTarget.blur()}}}/>
}
